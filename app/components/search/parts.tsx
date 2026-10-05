"use client";

import { useLayoutEffect, useRef } from "react";
import { OPERATORS, type QueryToken, SYNTAX } from "../../../src/search/query";
import { clock, dateTime, project } from "../../lib/format";
import { type ApiContext, KIND_COLOR, KIND_LABEL } from "./shared";

export function SearchIcon() {
  return (
    <svg className="sp-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <circle cx="7" cy="7" r="4.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** Text with highlight ranges (UTF-16 offsets) rendered as <mark>. Overlapping or out-of-range ranges are clamped. */
export function Marked({ text, ranges }: { text: string; ranges: readonly (readonly [number, number])[] }) {
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const [s0, e0] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const start = Math.max(at, Math.min(s0, text.length));
    const end = Math.min(e0, text.length);
    if (end <= start) continue;
    if (start > at) parts.push(text.slice(at, start));
    parts.push(<mark key={start}>{text.slice(start, end)}</mark>);
    at = end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

/** Case-insensitive occurrences of any term in `text`, for highlighting text the index did not snippet. */
export function termRanges(text: string, terms: string[]): [number, number][] {
  const words = terms.filter((t) => t.trim()).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return [];
  const re = new RegExp(words.join("|"), "giu");
  const out: [number, number][] = [];
  for (const m of text.matchAll(re)) if (m[0]) out.push([m.index, m.index + m[0].length]);
  return out;
}

/** Same-width copy of the query behind the transparent input, coloring recognized syntax. */
export function QueryMirror({ query, tokens }: { query: string; tokens: QueryToken[] }) {
  const out: React.ReactNode[] = [];
  let at = 0;
  for (const t of tokens) {
    if (t.start > at) out.push(query.slice(at, t.start));
    const cls = [
      "sp-tok",
      t.type === "operator" ? "sp-tok-op" : t.type === "tag" ? "sp-tok-tag" : t.type === "phrase" ? "sp-tok-phrase" : "",
      t.negated ? "sp-tok-neg" : "",
      t.error ? "sp-tok-err" : "",
    ]
      .filter(Boolean)
      .join(" ");
    if (t.type === "operator" && t.key) {
      const keyEnd = t.start + (t.negated ? 1 : 0) + t.key.length + 1;
      out.push(
        <span key={t.start} className={cls}>
          <span className="sp-tok-key">{query.slice(t.start, keyEnd)}</span>
          {query.slice(keyEnd, t.end)}
        </span>,
      );
    } else {
      out.push(
        <span key={t.start} className={cls}>
          {query.slice(t.start, t.end)}
        </span>,
      );
    }
    at = t.end;
  }
  if (at < query.length) out.push(query.slice(at));
  return <>{out}</>;
}

/** Scroll `container` so `el` is visible, without touching any other scroll ancestor. */
export function ensureVisible(container: HTMLElement | null, el: HTMLElement | null, center = false): void {
  if (!container || !el) return;
  const top = el.offsetTop;
  const bottom = top + el.offsetHeight;
  if (center) {
    container.scrollTop = top - container.clientHeight / 2 + el.offsetHeight / 2;
    return;
  }
  if (top < container.scrollTop) container.scrollTop = top - 8;
  else if (bottom > container.scrollTop + container.clientHeight) container.scrollTop = bottom - container.clientHeight + 8;
}

export function CheatSheet({ onInsert }: { onInsert: (text: string) => void }) {
  return (
    <div className="sp-cheats">
      <h3 className="sp-section">Syntax</h3>
      <ul className="sp-cheat-list">
        {SYNTAX.map((s) => (
          <li key={s.example}>
            <code className="sp-code">{s.example}</code>
            <span className="muted">{s.description}</span>
          </li>
        ))}
        {OPERATORS.map((o) => (
          <li key={o.key}>
            <button type="button" className="sp-code sp-code-btn" tabIndex={-1} onClick={() => onInsert(`${o.key}:`)}>
              {o.example}
            </button>
            <span className="muted">{o.description}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Events around the selected hit, the hit itself highlighted and centered. */
export function Preview({ ctx, stale, terms }: { ctx: ApiContext | null; stale: boolean; terms: string[] }) {
  const paneRef = useRef<HTMLDivElement>(null);
  const hitRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => ensureVisible(paneRef.current, hitRef.current, true), [ctx]);
  if (!ctx) {
    return (
      <div className="sp-preview sp-preview-empty muted" ref={paneRef}>
        Select a result to preview it.
      </div>
    );
  }
  const s = ctx.session;
  return (
    <div className={stale ? "sp-preview sp-stale" : "sp-preview"} ref={paneRef} aria-live="polite">
      <div className="sp-preview-head">
        <span className="swatch" style={{ background: s.color }} />
        <span className="sp-preview-title">{s.title || s.nativeId}</span>
        <span className="muted sp-preview-sub">
          {s.sourceLabel} · {project(s.cwd)} · {dateTime(s.startedAt)}
        </span>
      </div>
      {ctx.events.length === 0 && <div className="muted">No events.</div>}
      {ctx.events.map((e) => {
        const hit = e.seq === ctx.seq;
        return (
          <div key={e.seq} ref={hit ? hitRef : undefined} className={hit ? "sp-ctx sp-ctx-hit" : "sp-ctx"}>
            <div className="sp-ctx-head">
              <span className="ev-dot" style={{ background: e.isError ? "var(--kind-error)" : KIND_COLOR[e.kind], marginTop: 0 }} />
              <span>{KIND_LABEL[e.kind] ?? e.kind}</span>
              {e.toolName && <span className="tool-name">{e.toolName}</span>}
              <span className="muted sp-ctx-time">{clock(e.ts)}</span>
            </div>
            {e.toolInput && <div className="sp-ctx-input mono">{e.toolInput}</div>}
            {e.text && (
              <pre className={e.kind === "tool_result" || e.kind === "tool_call" ? "sp-ctx-text mono" : "sp-ctx-text"}>
                <Marked text={e.text} ranges={termRanges(e.text, terms)} />
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}
