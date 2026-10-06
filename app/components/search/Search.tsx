"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { isEmptyQuery, OPERATORS, parseQuery, quoteValue, type Sort, tokenAt, tokenize } from "../../../src/search/query";
import { ago, clock, dateTime, project } from "../../lib/format";
import { CheatSheet, ensureVisible, Marked, Preview, QueryMirror, SearchIcon } from "./parts";
import { type ApiContext, type ApiFacets, type ApiSearch, KIND_COLOR, KIND_LABEL, sessionHref, TARGET_EVENT } from "./shared";
import "../../search.css";

const RECENT_KEY = "agent-monitor.search.recent";
const RECENT_MAX = 8;
/** The preview pane only shows (and only fetches) on wide viewports. */
const WIDE = "(min-width: 1000px)";

type Item =
  | { type: "group"; g: number; href: string }
  | { type: "hit"; g: number; h: number; href: string }
  | { type: "more"; g: number }
  | { type: "recent"; query: string };

interface Suggestion {
  label: string;
  insert: string;
  description?: string;
}

interface Completion {
  /** `value`: operator values or tags, owns ↑/↓/Enter. `key`: operator names, Tab only. */
  mode: "value" | "key";
  from: number;
  to: number;
  /** Start of the token being completed. */
  tokenStart: number;
  options: Suggestion[];
}

/** Global search: a topbar trigger plus the Ctrl/⌘K palette. */
export function Search() {
  const [open, setOpen] = useState(false);
  const [mac, setMac] = useState(false);
  const restoreRef = useRef<HTMLElement | null>(null);

  const show = useCallback(() => {
    if (document.activeElement instanceof HTMLElement) restoreRef.current = document.activeElement;
    setOpen(true);
  }, []);
  const close = useCallback(() => {
    setOpen(false);
    const el = restoreRef.current;
    requestAnimationFrame(() => {
      if (el?.isConnected) el.focus();
    });
  }, []);

  useEffect(() => setMac(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (open) close();
        else show();
      } else if (e.key === "/" && !open && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // Typing "/" in a field types a slash.
        const el = document.activeElement;
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return;
        if (el instanceof HTMLElement && el.isContentEditable) return;
        e.preventDefault();
        show();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, show, close]);

  return (
    <>
      <button type="button" className="sp-trigger" onClick={show} aria-haspopup="dialog" aria-keyshortcuts="Control+K Meta+K /">
        <SearchIcon />
        <span className="sp-trigger-label">Search…</span>
        <kbd className="sp-kbd">{mac ? "⌘K" : "Ctrl K"}</kbd>
      </button>
      <Palette open={open} onClose={close} mac={mac} />
    </>
  );
}

function Palette({ open, onClose, mac }: { open: boolean; onClose: () => void; mac: boolean }) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const acRef = useRef<HTMLDivElement>(null);
  const ctxCache = useRef(new Map<string, ApiContext>());

  const [query, setQuery] = useState("");
  const [caret, setCaret] = useState(0);
  const [sortPref, setSortPref] = useState<Sort>("relevance");
  const [data, setData] = useState<ApiSearch | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const [facets, setFacets] = useState<ApiFacets | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [acSel, setAcSel] = useState(0);
  const [acHidden, setAcHidden] = useState(false);
  const [ctx, setCtx] = useState<{ key: string; value: ApiContext } | null>(null);
  const [wide, setWide] = useState(false);

  const parsed = useMemo(() => parseQuery(query), [query]);
  const sort = parsed.sort ?? sortPref;
  const terms = useMemo(() => parsed.must.map((c) => c.text), [parsed]);
  const tokenError = parsed.tokens.find((t) => t.error)?.error;
  const completion = useMemo<Completion | null>(() => {
    if (acHidden) return null;
    const t = tokenAt(parsed.tokens, caret);
    if (!t) return null;
    const neg = t.negated ? 1 : 0;
    const rank = (mode: Completion["mode"], from: number, to: number, typed: string, options: Suggestion[]): Completion | null => {
      const lower = typed.replace(/^"/, "").toLowerCase();
      const matched = options
        .filter((o) => o.label.toLowerCase().includes(lower))
        .sort((a, b) => Number(!a.label.toLowerCase().startsWith(lower)) - Number(!b.label.toLowerCase().startsWith(lower)))
        .slice(0, 8);
      if (!matched.length || (matched.length === 1 && matched[0].insert.toLowerCase() === lower)) return null;
      return { mode, from, to, tokenStart: t.start, options: matched };
    };
    if (t.type === "operator" && t.key) {
      const from = t.start + neg + t.key.length + 1;
      if (caret < from) return null;
      const spec = OPERATORS.find((o) => o.key === t.key);
      if (!spec) return null;
      let options: Suggestion[] = spec.values?.map((v) => ({ label: v.value, insert: v.value, description: v.description })) ?? [];
      if (spec.facet && facets) {
        if (spec.facet === "projects") {
          const seen = new Set<string>();
          for (const p of facets.projects) {
            const short = project(p.cwd);
            if (seen.has(short)) continue;
            seen.add(short);
            options.push({ label: short, insert: short, description: p.cwd });
          }
        } else {
          options = facets[spec.facet].map((f) => ({ label: f.name, insert: f.name, description: `${f.count}` }));
        }
      }
      return rank("value", from, t.end, query.slice(from, caret), options);
    }
    if (t.type === "tag" && facets) {
      const from = t.start + neg + 1;
      return rank("value", from, t.end, query.slice(from, caret), facets.tags.map((f) => ({ label: f.name, insert: f.name, description: `${f.count}` })));
    }
    if (t.type === "term" && !t.negated && caret === t.end && t.value.length >= 2 && !t.value.includes(":")) {
      const lower = t.value.toLowerCase();
      const options = OPERATORS.filter((o) => o.key.startsWith(lower) && o.key !== lower).map((o) => ({
        label: `${o.key}:`,
        insert: `${o.key}:`,
        description: o.description,
      }));
      return options.length ? { mode: "key", from: t.start, to: t.end, tokenStart: t.start, options } : null;
    }
    return null;
  }, [acHidden, parsed, caret, query, facets]);
  const acIndex = completion ? Math.min(acSel, completion.options.length - 1) : 0;
  // An operator value still being picked from the dropdown is left out of the search, so `tool:b` does not filter to nothing.
  const searchQuery =
    completion?.mode === "value" && completion.to === query.length && caret === query.length ? query.slice(0, completion.tokenStart) : query;
  const empty = useMemo(() => isEmptyQuery(parseQuery(searchQuery)), [searchQuery]);

  // Open / close the native modal dialog (top layer, inert background).
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      inputRef.current?.focus();
      inputRef.current?.select();
      try {
        const stored: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
        if (Array.isArray(stored)) setRecent(stored.filter((q): q is string => typeof q === "string").slice(0, RECENT_MAX));
      } catch {
        // Unavailable or corrupt storage: no recents.
      }
      fetch("/api/search?facets=1")
        .then((r) => (r.ok ? (r.json() as Promise<ApiFacets>) : null))
        .then((f) => f && setFacets(f))
        .catch(() => {});
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    const mq = window.matchMedia(WIDE);
    const update = () => setWide(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // Debounced search; aborts the previous request; previous results stay until new ones arrive.
  useEffect(() => {
    if (!open) return;
    if (empty) {
      setData(null);
      setError(null);
      setLoading(false);
      setSel(0);
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(searchQuery)}&sort=${sortPref}`, { signal: ctrl.signal });
        if (!res.ok) {
          // Error responses carry `{ error }` (503 when the search addon is missing); fall back to the status line.
          const failed = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(failed?.error || `${res.status} ${res.statusText}`);
        }
        const body = (await res.json()) as ApiSearch;
        setData(body);
        setError(null);
        setSel(body.groups[0]?.hits.length ? 1 : 0);
      } catch (e) {
        if (!ctrl.signal.aborted) {
          setError(e instanceof Error ? e.message : String(e));
          setData(null);
          setSel(0);
        }
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }, 100);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [open, searchQuery, sortPref, empty]);

  const items = useMemo<Item[]>(() => {
    if (empty) return recent.map((q) => ({ type: "recent", query: q }));
    const out: Item[] = [];
    data?.groups.forEach((g, gi) => {
      out.push({ type: "group", g: gi, href: sessionHref(g.session.id) });
      g.hits.forEach((h, hi) => out.push({ type: "hit", g: gi, h: hi, href: sessionHref(g.session.id, h.seq) }));
      if (g.more) out.push({ type: "more", g: gi });
    });
    return out;
  }, [empty, recent, data]);

  const selIndex = Math.min(sel, items.length - 1);
  const current = items[selIndex];

  useLayoutEffect(() => {
    ensureVisible(listRef.current, document.getElementById(`sp-item-${selIndex}`));
  }, [selIndex, items]);

  // Preview: session start for a group header, the hit's surroundings for a hit.
  const target =
    data && current && (current.type === "hit" || current.type === "group")
      ? { id: data.groups[current.g].session.id, seq: current.type === "hit" ? data.groups[current.g].hits[current.h].seq : -1 }
      : null;
  const termQuery = terms.map((t) => quoteValue(t)).join(" ");
  const ctxKey = target ? `${target.id}\n${target.seq}\n${termQuery}` : null;
  useEffect(() => {
    if (!open || !wide || !target || !ctxKey) return;
    const cached = ctxCache.current.get(ctxKey);
    if (cached) {
      setCtx({ key: ctxKey, value: cached });
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/search/context?session=${encodeURIComponent(target.id)}&seq=${target.seq}&q=${encodeURIComponent(termQuery)}`,
          { signal: ctrl.signal },
        );
        if (!res.ok) return;
        const value = (await res.json()) as ApiContext;
        const cache = ctxCache.current;
        cache.set(ctxKey, value);
        if (cache.size > 100) cache.delete(cache.keys().next().value as string);
        setCtx({ key: ctxKey, value });
      } catch {
        // Aborted or offline: keep the previous preview.
      }
    }, 90);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
    // `target` and `termQuery` are encoded in ctxKey.
  }, [open, wide, ctxKey]);

  useLayoutEffect(() => {
    ensureVisible(acRef.current, document.getElementById(`sp-ac-${acIndex}`));
  }, [acIndex, completion]);

  // Keep the colored mirror aligned with the input's horizontal scroll.
  useLayoutEffect(() => {
    if (mirrorRef.current && inputRef.current) mirrorRef.current.scrollLeft = inputRef.current.scrollLeft;
  }, [query, caret]);

  const setQueryAt = (next: string, pos: number) => {
    setQuery(next);
    setCaret(pos);
    setAcSel(0);
    setAcHidden(false);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(pos, pos);
    });
  };

  const accept = (c: Completion, option: Suggestion) => {
    const before = query.slice(0, c.from);
    const after = query.slice(c.to);
    const insert = c.mode === "key" ? option.insert : `${quoteValue(option.insert)}${after.startsWith(" ") ? "" : " "}`;
    setQueryAt(before + insert + after, before.length + insert.length);
  };

  const remember = () => {
    const q = query.trim();
    if (!q) return;
    const next = [q, ...recent.filter((r) => r !== q)].slice(0, RECENT_MAX);
    setRecent(next);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      // Storage full or disabled: recents are a convenience.
    }
  };

  const activate = (item: Item, newTab: boolean) => {
    if (item.type === "recent") {
      setQueryAt(item.query, item.query.length);
      return;
    }
    if (item.type === "more") {
      // Narrow to this session: replace any earlier `in:` rather than stacking them, and put it first so the
      // query still ends with the user's own word, which keeps matching as a prefix ("archive" -> "archived").
      const rest = tokenize(query)
        .filter((t) => t.key === "in")
        .reduceRight((q, t) => q.slice(0, t.start) + q.slice(t.end), query)
        .replace(/\s+/g, " ")
        .trimStart();
      const next = `in:${data?.groups[item.g].session.id} ${rest}`;
      setQueryAt(next, next.length);
      return;
    }
    remember();
    if (newTab) {
      window.open(item.href, "_blank", "noopener,noreferrer");
      return;
    }
    onClose();
    router.push(item.href);
    if (item.href.includes("#")) window.dispatchEvent(new CustomEvent(TARGET_EVENT, { detail: item.href }));
  };

  const move = (delta: number) => {
    if (!items.length) return;
    setSel((selIndex + delta + items.length) % items.length);
  };

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    const mod = e.metaKey || e.ctrlKey;
    if (completion) {
      const active = completion.mode === "value";
      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        accept(completion, completion.options[active ? acIndex : 0]);
        return;
      }
      if (active) {
        const n = completion.options.length;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          setAcSel((acIndex + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
          return;
        }
        if (e.key === "Enter" && !mod) {
          e.preventDefault();
          accept(completion, completion.options[acIndex]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setAcHidden(true);
          return;
        }
      }
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      move(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (current) activate(current, mod);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  // Focus stays inside the palette: Tab cycles its own controls.
  const onDialogKeyDown = (e: React.KeyboardEvent<HTMLDialogElement>) => {
    if (e.key !== "Tab" || !dialogRef.current) return;
    const nodes = [...dialogRef.current.querySelectorAll<HTMLElement>("input, button:not([disabled]):not([tabindex='-1'])")];
    if (!nodes.length) return;
    const i = nodes.indexOf(document.activeElement as HTMLElement);
    e.preventDefault();
    nodes[(i + (e.shiftKey ? nodes.length - 1 : 1) + nodes.length) % nodes.length].focus();
  };

  const onItemClick = (e: React.MouseEvent, item: Item) => {
    // Modified clicks on links keep the browser's own behavior (new tab, new window).
    if (item.type !== "recent" && item.type !== "more" && (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0)) {
      remember();
      return;
    }
    e.preventDefault();
    activate(item, false);
  };

  const itemProps = (i: number, item: Item) => ({
    id: `sp-item-${i}`,
    role: "option",
    "aria-selected": i === selIndex,
    "data-selected": i === selIndex || undefined,
    tabIndex: -1,
    onMouseMove: () => {
      if (i !== selIndex) setSel(i);
    },
    onClick: (e: React.MouseEvent) => onItemClick(e, item),
  });

  const insertAtEnd = (text: string) => {
    const base = query && !query.endsWith(" ") ? `${query} ` : query;
    setQueryAt(base + text, base.length + text.length);
  };

  const showPreview = wide && !empty;
  const previewStale = !!ctx && ctx.key !== ctxKey;

  return (
    <dialog
      ref={dialogRef}
      className="sp-dialog"
      aria-label="Search sessions"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={onDialogKeyDown}
    >
      <div className="sp-panel" data-preview={showPreview || undefined}>
        <div className="sp-field">
          <SearchIcon />
          <div className="sp-input-wrap">
            <div className="sp-mirror" ref={mirrorRef} aria-hidden="true">
              <QueryMirror query={query} tokens={parsed.tokens} />
            </div>
            <input
              ref={inputRef}
              className="sp-input"
              value={query}
              placeholder="Search prompts, replies, tool calls…  try kind:error or #tag"
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              role="combobox"
              aria-expanded={items.length > 0}
              aria-controls="sp-listbox"
              aria-autocomplete="list"
              aria-activedescendant={current ? `sp-item-${selIndex}` : undefined}
              onChange={(e) => {
                setQuery(e.target.value);
                setCaret(e.target.selectionStart ?? e.target.value.length);
                setAcSel(0);
                setAcHidden(false);
              }}
              onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
              onScroll={(e) => {
                if (mirrorRef.current) mirrorRef.current.scrollLeft = e.currentTarget.scrollLeft;
              }}
              onKeyDown={onInputKeyDown}
            />
          </div>
          <div className="sp-sort" role="group" aria-label="Sort">
            {(["relevance", "newest"] as const).map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={sort === s}
                title={parsed.sort ? "Set by sort: in the query" : undefined}
                onClick={() => {
                  setSortPref(s);
                  inputRef.current?.focus();
                }}
              >
                {s === "relevance" ? "Best" : "Newest"}
              </button>
            ))}
          </div>
          <kbd className="sp-kbd">esc</kbd>
          {completion && (
            <div className={completion.mode === "key" ? "sp-ac sp-ac-key" : "sp-ac"} ref={acRef} role="listbox" aria-label="Suggestions">
              {completion.mode === "key" && <span className="sp-ac-hint">Tab</span>}
              {completion.options.map((o, i) => (
                <div
                  key={o.label}
                  id={`sp-ac-${i}`}
                  role="option"
                  aria-selected={completion.mode === "value" && i === acIndex}
                  className="sp-ac-item"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    accept(completion, o);
                  }}
                >
                  <span className="mono">{o.label}</span>
                  {o.description && <span className="muted sp-ac-desc">{o.description}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
        {loading && <div className="sp-progress" aria-hidden="true" />}

        <div className="sp-body">
          <div className="sp-list" ref={listRef} id="sp-listbox" role="listbox" aria-label="Results">
            {empty ? (
              <div className="sp-home">
                <div>
                  <h3 className="sp-section">Recent</h3>
                  {recent.length === 0 && <p className="muted sp-pad">Your searches will show up here.</p>}
                  {items.map((item, i) =>
                    item.type === "recent" ? (
                      <div key={item.query} className="sp-recent" {...itemProps(i, item)}>
                        <span className="muted">↺</span>
                        <span className="sp-recent-q">{item.query}</span>
                      </div>
                    ) : null,
                  )}
                </div>
                <CheatSheet onInsert={insertAtEnd} />
              </div>
            ) : error ? (
              <div className="sp-pad">
                <p className="error-text" role="alert">
                  {error}
                </p>
              </div>
            ) : !data ? (
              <p className="muted sp-pad">Searching…</p>
            ) : data.groups.length === 0 ? (
              <div className="sp-pad">
                <p>No matches.</p>
                <p className="muted">Try fewer words, a shorter prefix, or drop a filter.</p>
              </div>
            ) : (
              items.map((item, i) => {
                if (item.type === "recent") return null;
                const g = data.groups[item.g];
                const s = g.session;
                if (item.type === "group") {
                  return (
                    <a key={`g-${s.id}`} href={item.href} className="sp-group" {...itemProps(i, item)}>
                      <span className="sp-group-line">
                        <span className="swatch" style={{ background: s.color }} title={s.sourceLabel} />
                        <span className="sp-group-title">{s.title || s.nativeId}</span>
                        {s.parentId && (
                          <span className="sp-sub" title={`Subagent of ${s.parentTitle || s.parentId}`}>
                            ↳ subagent
                          </span>
                        )}
                        {s.tags.map((t) => (
                          <span key={t} className="badge sp-tag">
                            #{t}
                          </span>
                        ))}
                        {s.autoTags.map((t) => (
                          <span key={t.tag} className="badge sp-tag tag-auto" title={`Automatic tag: ${t.reason}`}>
                            {t.tag}
                          </span>
                        ))}
                        <span className="sp-group-time">{ago(s.endedAt)}</span>
                      </span>
                      <span className="sp-group-meta">
                        {s.sourceLabel} · {project(s.cwd)}
                        {s.gitBranch && ` · ${s.gitBranch}`}
                        {s.parentId && s.parentTitle && ` · in ${s.parentTitle}`}
                      </span>
                      {g.sessionHit && (
                        <span className="sp-session-hit">
                          <Marked text={g.sessionHit.snippet} ranges={g.sessionHit.highlights} />
                        </span>
                      )}
                    </a>
                  );
                }
                if (item.type === "more") {
                  return (
                    <div key={`m-${s.id}`} className="sp-more" {...itemProps(i, item)}>
                      +{g.more} more in this session <span className="muted">↵ search within</span>
                    </div>
                  );
                }
                const h = g.hits[item.h];
                return (
                  <a key={`h-${s.id}-${h.seq}`} href={item.href} className="sp-hit" {...itemProps(i, item)}>
                    <span className="sp-hit-kind">
                      <span className="ev-dot" style={{ background: h.isError ? "var(--kind-error)" : KIND_COLOR[h.kind], marginTop: 0 }} />
                      {KIND_LABEL[h.kind] ?? h.kind}
                    </span>
                    <span className="sp-hit-snippet">
                      {h.toolName && <span className="tool-name">{h.toolName} </span>}
                      <Marked text={h.snippet} ranges={h.highlights} />
                    </span>
                    <span className="sp-hit-time">
                      {new Date(h.ts).toDateString() === new Date().toDateString() ? clock(h.ts) : dateTime(h.ts)}
                    </span>
                  </a>
                );
              })
            )}
          </div>
          {showPreview && <Preview ctx={target && ctx ? ctx.value : null} stale={previewStale} terms={terms} />}
        </div>

        <div className="sp-footer">
          <span className="sp-keys">
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate <kbd>↵</kbd> open <kbd>{mac ? "⌘↵" : "Ctrl ↵"}</kbd> new tab <kbd>Tab</kbd> complete
          </span>
          <span className="sp-stats">
            {tokenError ? (
              <span className="error-text">{tokenError}</span>
            ) : data && !empty ? (
              `${data.totalHits}${data.limited ? "+" : ""} hits · ${data.groups.length} sessions · ${data.tookMs} ms`
            ) : null}
          </span>
        </div>
      </div>
    </dialog>
  );
}
