//! Full-text index over agent session events, exposed to Node via napi.
//!
//! The index lives in a directory shared by the dashboard server and the CLI, so a
//! writer is only held for the duration of one `apply` call.

use std::collections::BTreeMap;
use std::ops::Bound;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};

use napi::{Error, Result};
use napi_derive::napi;
use tantivy::collector::TopDocs;
use tantivy::directory::MmapDirectory;
use tantivy::directory::error::LockError;
use tantivy::query::{
    AllQuery, BooleanQuery, InvertedIndexRangeQuery, Occur, PhrasePrefixQuery, PhraseQuery, Query,
    RangeQuery, TermQuery, TermSetQuery,
};
use tantivy::schema::{
    FAST, Field, INDEXED, IndexRecordOption, STORED, STRING, Schema, TextFieldIndexing,
    TextOptions, Value,
};
use tantivy::snippet::SnippetGenerator;
use tantivy::tokenizer::{
    AsciiFoldingFilter, LowerCaser, RemoveLongFilter, SimpleTokenizer, TextAnalyzer,
};
use tantivy::{
    DocAddress, Index, IndexReader, IndexWriter, Order, ReloadPolicy, Score, TantivyDocument,
    TantivyError, Term,
};

const TOKENIZER: &str = "code";
const SNIPPET_CHARS: usize = 180;
const WRITER_HEAP_BYTES: usize = 50_000_000;
/// Distinct terms a trailing prefix may expand to inside a phrase.
const PHRASE_PREFIX_EXPANSIONS: u32 = 200;
/// Distinct terms a prefix contributes to snippet highlighting.
const SNIPPET_PREFIX_EXPANSIONS: usize = 64;

#[napi(object)]
pub struct IndexDoc {
    pub session_id: String,
    pub seq: i64,
    pub ts: i64,
    pub kind: String,
    pub source: String,
    pub tool: Option<String>,
    pub text: String,
}

#[napi(object)]
pub struct ApplyBatch {
    pub reset: Option<bool>,
    pub delete_sessions: Vec<String>,
    pub add: Vec<IndexDoc>,
    pub generation: i64,
}

#[napi(object)]
pub struct Clause {
    #[napi(js_name = "type")]
    pub kind: String,
    pub text: String,
}

#[napi(object)]
pub struct SearchRequest {
    pub must: Vec<Clause>,
    pub must_not: Vec<Clause>,
    pub kinds: Option<Vec<String>>,
    pub sources: Option<Vec<String>>,
    pub tools: Option<Vec<String>>,
    pub session_ids: Option<Vec<String>>,
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub sort: String,
    pub limit: u32,
}

#[napi(object)]
pub struct SearchHit {
    pub session_id: String,
    pub seq: i64,
    pub ts: i64,
    pub kind: String,
    pub score: f64,
    pub snippet: String,
    pub highlights: Vec<Vec<u32>>,
}

#[derive(Clone, Copy)]
struct Fields {
    session_id: Field,
    seq: Field,
    ts: Field,
    kind: Field,
    source: Field,
    tool: Field,
    text: Field,
}

fn build_schema() -> (Schema, Fields) {
    let mut b = Schema::builder();
    let text_options = TextOptions::default().set_stored().set_indexing_options(
        TextFieldIndexing::default()
            .set_tokenizer(TOKENIZER)
            .set_index_option(IndexRecordOption::WithFreqsAndPositions),
    );
    let fields = Fields {
        session_id: b.add_text_field("session_id", STRING | STORED | FAST),
        seq: b.add_i64_field("seq", STORED | FAST),
        ts: b.add_i64_field("ts", INDEXED | STORED | FAST),
        kind: b.add_text_field("kind", STRING | STORED | FAST),
        source: b.add_text_field("source", STRING | FAST),
        tool: b.add_text_field("tool", STRING),
        text: b.add_text_field("text", text_options),
    };
    (b.build(), fields)
}

fn code_analyzer() -> TextAnalyzer {
    TextAnalyzer::builder(SimpleTokenizer::default())
        .filter(RemoveLongFilter::limit(64))
        .filter(LowerCaser)
        .filter(AsciiFoldingFilter)
        .build()
}

fn err(e: impl std::fmt::Display) -> Error {
    Error::from_reason(e.to_string())
}

/// Opens the index in `dir`, recreating it when missing, unreadable or built with another schema.
fn open_or_recreate(dir: &Path, schema: &Schema) -> Result<Index> {
    std::fs::create_dir_all(dir).map_err(err)?;
    let directory = MmapDirectory::open(dir).map_err(err)?;
    if Index::exists(&directory).map_err(err)? {
        if let Ok(index) = Index::open(directory) {
            if index.schema() == *schema {
                return Ok(index);
            }
        }
        std::fs::remove_dir_all(dir).map_err(err)?;
        std::fs::create_dir_all(dir).map_err(err)?;
    }
    Index::create_in_dir(dir, schema.clone()).map_err(err)
}

/// Smallest byte string greater than every string starting with `prefix` (None: unbounded).
fn prefix_end(prefix: &[u8]) -> Option<Vec<u8>> {
    let mut end = prefix.to_vec();
    while let Some(last) = end.pop() {
        if last < u8::MAX {
            end.push(last + 1);
            return Some(end);
        }
    }
    None
}

fn utf16_offset(s: &str, byte: usize) -> u32 {
    s[..byte].encode_utf16().count() as u32
}

fn term_or_phrase(terms: Vec<Term>) -> Box<dyn Query> {
    if terms.len() == 1 {
        let term = terms.into_iter().next().expect("one term");
        Box::new(TermQuery::new(term, IndexRecordOption::WithFreqs))
    } else {
        Box::new(PhraseQuery::new(terms))
    }
}

enum ClauseKind {
    Exact,
    Prefix,
}

/// A clause after tokenization; `tokens` is never empty.
struct ParsedClause {
    kind: ClauseKind,
    tokens: Vec<String>,
}

#[napi]
pub struct SearchIndex {
    index: Index,
    reader: IndexReader,
    fields: Fields,
    analyzer: TextAnalyzer,
    /// Opstamp of the commit the reader was last loaded at (see `refresh`).
    loaded_opstamp: AtomicU64,
}

#[napi]
impl SearchIndex {
    #[napi(constructor)]
    pub fn new(dir: String) -> Result<Self> {
        let (schema, fields) = build_schema();
        let index = open_or_recreate(Path::new(&dir), &schema)?;
        let analyzer = code_analyzer();
        index.tokenizers().register(TOKENIZER, analyzer.clone());
        // Manual reloads only. OnCommitWithDelay starts a meta.json watcher thread that keeps running while
        // Node exits and then calls into torn-down code: next-server dumped core with SIGSEGV in that thread.
        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::Manual)
            .try_into()
            .map_err(err)?;
        let opstamp = index.load_metas().map_err(err)?.opstamp;
        Ok(SearchIndex {
            index,
            reader,
            fields,
            analyzer,
            loaded_opstamp: AtomicU64::new(opstamp),
        })
    }

    /// Reload the reader when another process (the CLI's sync) committed since it was loaded. Reading meta.json
    /// is cheap next to a search, and it replaces the watcher thread. If meta.json cannot be read (the index
    /// directory was deleted under a running server), keep serving the snapshot already loaded.
    fn refresh(&self) -> Result<()> {
        let Ok(metas) = self.index.load_metas() else { return Ok(()) };
        if self.loaded_opstamp.load(AtomicOrdering::Acquire) != metas.opstamp {
            self.reader.reload().map_err(err)?;
            self.loaded_opstamp.store(metas.opstamp, AtomicOrdering::Release);
        }
        Ok(())
    }

    /// Payload of the last commit as a number; null for a fresh index.
    #[napi]
    pub fn generation(&self) -> Result<Option<i64>> {
        let metas = self.index.load_metas().map_err(err)?;
        Ok(metas.payload.and_then(|p| p.trim().parse::<i64>().ok()))
    }

    #[napi]
    pub fn doc_count(&self) -> Result<f64> {
        self.refresh()?;
        Ok(self.reader.searcher().num_docs() as f64)
    }

    /// Applies deletions and additions in a single commit. The writer is released afterwards.
    #[napi]
    pub fn apply(&self, batch: ApplyBatch) -> Result<()> {
        let mut writer: IndexWriter = self
            .index
            .writer_with_num_threads(1, WRITER_HEAP_BYTES)
            .map_err(|e| match e {
                TantivyError::LockFailure(LockError::LockBusy, _) => {
                    Error::from_reason(format!("LOCKED: {e}"))
                }
                e => err(e),
            })?;
        let f = self.fields;
        if batch.reset.unwrap_or(false) {
            writer.delete_all_documents().map_err(err)?;
        }
        for id in &batch.delete_sessions {
            writer.delete_term(Term::from_field_text(f.session_id, id));
        }
        for d in batch.add {
            let mut doc = TantivyDocument::default();
            doc.add_text(f.session_id, &d.session_id);
            doc.add_i64(f.seq, d.seq);
            doc.add_i64(f.ts, d.ts);
            doc.add_text(f.kind, &d.kind);
            doc.add_text(f.source, &d.source);
            if let Some(tool) = d.tool.as_deref().filter(|t| !t.is_empty()) {
                doc.add_text(f.tool, tool.to_lowercase());
            }
            doc.add_text(f.text, &d.text);
            writer.add_document(doc).map_err(err)?;
        }
        let mut prepared = writer.prepare_commit().map_err(err)?;
        prepared.set_payload(&batch.generation.to_string());
        prepared.commit().map_err(err)?;
        // Let pending merges finish so small incremental commits do not pile up segments.
        writer.wait_merging_threads().map_err(err)?;
        self.reader.reload().map_err(err)?;
        self.loaded_opstamp.store(self.index.load_metas().map_err(err)?.opstamp, AtomicOrdering::Release);
        Ok(())
    }

    #[napi]
    pub fn search(&self, req: SearchRequest) -> Result<Vec<SearchHit>> {
        if req.limit == 0 {
            return Ok(Vec::new());
        }
        let must = self.parse_clauses(&req.must)?;
        self.refresh()?;
        let must_not = self.parse_clauses(&req.must_not)?;
        let f = self.fields;

        let mut clauses: Vec<(Occur, Box<dyn Query>)> = Vec::new();
        for c in &must {
            clauses.push((Occur::Must, self.clause_query(c)));
        }
        if must.is_empty() {
            clauses.push((Occur::Must, Box::new(AllQuery)));
        }
        for c in &must_not {
            clauses.push((Occur::MustNot, self.clause_query(c)));
        }
        let string_filters = [
            (f.kind, &req.kinds, false),
            (f.source, &req.sources, false),
            (f.tool, &req.tools, true),
        ];
        for (field, values, lowercase) in string_filters {
            // An empty list means "no restriction" for facet filters.
            if let Some(values) = values.as_ref().filter(|v| !v.is_empty()) {
                clauses.push((Occur::Must, term_set(field, values, lowercase)));
            }
        }
        if let Some(ids) = &req.session_ids {
            // Session ids are a resolved restriction: an empty set matches nothing.
            if ids.is_empty() {
                return Ok(Vec::new());
            }
            clauses.push((Occur::Must, term_set(f.session_id, ids, false)));
        }
        if req.from.is_some() || req.to.is_some() {
            let lower = req
                .from
                .map_or(Bound::Unbounded, |v| Bound::Included(Term::from_field_i64(f.ts, v)));
            let upper = req
                .to
                .map_or(Bound::Unbounded, |v| Bound::Excluded(Term::from_field_i64(f.ts, v)));
            clauses.push((Occur::Must, Box::new(RangeQuery::new(lower, upper))));
        }
        let query = BooleanQuery::new(clauses);

        let searcher = self.reader.searcher();
        let limit = req.limit as usize;
        let by_relevance = !must.is_empty() && req.sort == "relevance";
        let hits: Vec<(f64, DocAddress)> = if by_relevance {
            searcher
                .search(&query, &TopDocs::with_limit(limit).order_by_score())
                .map_err(err)?
                .into_iter()
                .map(|(score, addr)| (score as f64, addr))
                .collect()
        } else {
            searcher
                .search(
                    &query,
                    &TopDocs::with_limit(limit).order_by_fast_field::<i64>("ts", Order::Desc),
                )
                .map_err(err)?
                .into_iter()
                .map(|(_, addr)| (0.0, addr))
                .collect()
        };

        let snippets = if must.is_empty() {
            None
        } else {
            let mut generator = SnippetGenerator::new(
                self.snippet_terms(&searcher, &must)?,
                self.analyzer.clone(),
                f.text,
                SNIPPET_CHARS,
            );
            generator.set_max_num_chars(SNIPPET_CHARS);
            Some(generator)
        };

        let mut out = Vec::with_capacity(hits.len());
        for (score, addr) in hits {
            let doc: TantivyDocument = searcher.doc(addr).map_err(err)?;
            let str_of = |field| doc.get_first(field).and_then(|v| v.as_str()).unwrap_or("");
            let i64_of = |field| doc.get_first(field).and_then(|v| v.as_i64()).unwrap_or(0);
            let text = str_of(f.text);
            let (snippet, highlights) = match snippets.as_ref().map(|g| g.snippet(text)) {
                Some(s) if !s.fragment().is_empty() => {
                    let fragment = s.fragment();
                    let ranges = s
                        .highlighted()
                        .iter()
                        .map(|r| vec![utf16_offset(fragment, r.start), utf16_offset(fragment, r.end)])
                        .collect();
                    (fragment.to_string(), ranges)
                }
                _ => (text.chars().take(SNIPPET_CHARS).collect(), Vec::new()),
            };
            out.push(SearchHit {
                session_id: str_of(f.session_id).to_string(),
                seq: i64_of(f.seq),
                ts: i64_of(f.ts),
                kind: str_of(f.kind).to_string(),
                score,
                snippet,
                highlights,
            });
        }
        Ok(out)
    }
}

fn term_set(field: Field, values: &[String], lowercase: bool) -> Box<dyn Query> {
    Box::new(TermSetQuery::new(values.iter().map(|v| {
        if lowercase {
            Term::from_field_text(field, &v.to_lowercase())
        } else {
            Term::from_field_text(field, v)
        }
    })))
}

impl SearchIndex {
    fn tokens(&self, text: &str) -> Vec<String> {
        let mut analyzer = self.analyzer.clone();
        let mut stream = analyzer.token_stream(text);
        let mut tokens = Vec::new();
        while stream.advance() {
            tokens.push(stream.token().text.clone());
        }
        tokens
    }

    /// Tokenizes clauses; clauses without any token are dropped.
    fn parse_clauses(&self, clauses: &[Clause]) -> Result<Vec<ParsedClause>> {
        let mut out = Vec::with_capacity(clauses.len());
        for c in clauses {
            let kind = match c.kind.as_str() {
                "term" | "phrase" => ClauseKind::Exact,
                "prefix" => ClauseKind::Prefix,
                other => return Err(Error::from_reason(format!("unknown clause type {other:?}"))),
            };
            let tokens = self.tokens(&c.text);
            if !tokens.is_empty() {
                out.push(ParsedClause { kind, tokens });
            }
        }
        Ok(out)
    }

    fn clause_query(&self, c: &ParsedClause) -> Box<dyn Query> {
        let field = self.fields.text;
        let terms: Vec<Term> = c
            .tokens
            .iter()
            .map(|t| Term::from_field_text(field, t))
            .collect();
        match c.kind {
            ClauseKind::Exact => term_or_phrase(terms),
            ClauseKind::Prefix if terms.len() == 1 => {
                let prefix = &c.tokens[0];
                let upper = match prefix_end(prefix.as_bytes()) {
                    Some(end) => {
                        let mut term = Term::from_field_text(field, "");
                        term.set_bytes(&end);
                        Bound::Excluded(term)
                    }
                    None => Bound::Unbounded,
                };
                let lower = Bound::Included(Term::from_field_text(field, prefix));
                Box::new(InvertedIndexRangeQuery::new(lower, upper))
            }
            ClauseKind::Prefix => {
                let mut query = PhrasePrefixQuery::new(terms);
                query.set_max_expansions(PHRASE_PREFIX_EXPANSIONS);
                Box::new(query)
            }
        }
    }

    /// Terms to highlight, weighted like tantivy's own generator (rarer terms score higher).
    /// Trailing prefix tokens are expanded through the term dictionary.
    fn snippet_terms(
        &self,
        searcher: &tantivy::Searcher,
        clauses: &[ParsedClause],
    ) -> Result<BTreeMap<String, Score>> {
        let field = self.fields.text;
        let mut terms = BTreeMap::new();
        let mut add = |text: String| -> Result<()> {
            let df = searcher
                .doc_freq(&Term::from_field_text(field, &text))
                .map_err(err)?;
            if df > 0 {
                terms.insert(text, 1.0 / (1.0 + df as Score));
            }
            Ok(())
        };
        for c in clauses {
            let (exact, prefix) = match c.kind {
                ClauseKind::Exact => (&c.tokens[..], None),
                ClauseKind::Prefix => {
                    let (last, rest) = c.tokens.split_last().expect("non-empty");
                    (rest, Some(last))
                }
            };
            for t in exact {
                add(t.clone())?;
            }
            let Some(prefix) = prefix else { continue };
            let end = prefix_end(prefix.as_bytes());
            let mut expanded = Vec::new();
            'segments: for segment in searcher.segment_readers() {
                let inverted = segment.inverted_index(field).map_err(err)?;
                let mut range = inverted.terms().range().ge(prefix.as_bytes());
                if let Some(end) = &end {
                    range = range.lt(end);
                }
                let mut stream = range.into_stream().map_err(err)?;
                while stream.advance() {
                    if let Ok(s) = std::str::from_utf8(stream.key()) {
                        expanded.push(s.to_string());
                    }
                    if expanded.len() >= SNIPPET_PREFIX_EXPANSIONS {
                        break 'segments;
                    }
                }
            }
            expanded.sort_unstable();
            expanded.dedup();
            for t in expanded {
                add(t)?;
            }
        }
        Ok(terms)
    }
}
