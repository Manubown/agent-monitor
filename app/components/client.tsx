"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useId, useOptimistic, useRef, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import type { AutoTag } from "../../src/core/autotags";
import { addTag, removeTag } from "../actions";
import { ago } from "../lib/format";
import { type LiveSignal, type LiveView, liveStep, type SyncEvent, type SyncHealth, syncedAt } from "../lib/live";
import "../features.css";
import { AutoTagChip } from "./AutoTagChip";
import { setMotion, useMotion } from "./pixel/motion";

export function Nav() {
  const pathname = usePathname();
  const links = [
    { href: "/", label: "Overview", active: pathname === "/" },
    { href: "/sessions", label: "Sessions", active: pathname.startsWith("/sessions") },
    { href: "/projects", label: "Projects", active: pathname.startsWith("/projects") },
    { href: "/usage", label: "Usage windows", active: pathname.startsWith("/usage") },
    { href: "/errors", label: "Errors", active: pathname.startsWith("/errors") },
  ];
  return (
    <nav className="nav">
      {links.map((l) => (
        <Link key={l.href} href={l.href} aria-current={l.active ? "page" : undefined}>
          {l.label}
        </Link>
      ))}
    </nav>
  );
}

export function SyncButton() {
  const { pending } = useFormStatus();
  return (
    <button className="btn" type="submit" disabled={pending}>
      {pending ? "Syncing…" : "Sync now"}
    </button>
  );
}

/**
 * Top-bar switch for decorative motion (WCAG 2.2.2). Mirrors the choice on <html data-motion>, which gates the
 * stepped hover animations in CSS; the pixel band subscribes to the same store.
 */
export function MotionToggle() {
  const on = useMotion();
  useEffect(() => {
    if (on !== null) document.documentElement.dataset.motion = on ? "on" : "off";
  }, [on]);
  return (
    <button
      className="btn btn-motion"
      type="button"
      aria-pressed={on ?? undefined}
      disabled={on === null}
      onClick={() => setMotion(!on)}
      title="Animated pixel band and hover effects. Follows your system's reduced-motion setting until you change it here."
    >
      Motion {on === null ? "" : on ? "on" : "off"}
    </button>
  );
}

const REFRESH_INTERVAL_MS = 2000;
const RECONNECT_MS = 5000;
/** Window event carrying the import progress (`{ files }`) from the live stream to `ImportProgress`. */
const PROGRESS_EVENT = "agent-monitor:progress";
/** Window event carrying the end of each successful sync (`{ at }`) from the live stream to `SyncedAgo`. */
const SYNCED_EVENT = "agent-monitor:synced";
/** How often `SyncedAgo` recomputes its relative time ("2 min ago" changes at most once a minute). */
const AGO_TICK_MS = 15_000;

/**
 * Subscribes to /api/live and re-renders the current page when a sync changed
 * what it shows (`affectsPage`), or the top bar's problems or file counts
 * changed: at most once per 2 s. A sync that changed data but not this page is
 * remembered, and the next URL change (a link, Back, Forward) refreshes once,
 * since the router's cached payloads of other routes may predate it
 * (`liveStep`). The stream is open only while the tab is visible, so
 * background tabs do not hold one of the browser's few connections per host;
 * on return the `hello` event's generation tells whether anything was written
 * meanwhile (then the page refreshes, whatever changed).
 *
 * `generation` and `health` describe the first server render only: LiveRefresh
 * sits in the root layout and stays mounted across navigations and refreshes,
 * so it reads them once at mount and then follows the stream.
 */
export function LiveRefresh({ generation, health }: { generation: number | null; health: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<"connecting" | "live" | "reconnecting">("connecting");
  const [initial] = useState<LiveView>(() => ({ generation, health, skipped: false }));
  /** Set while the stream effect runs; `UrlChange` calls it after every URL change. */
  const navigated = useRef<() => void>(() => {});

  useEffect(() => {
    let source: EventSource | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let throttle: ReturnType<typeof setTimeout> | undefined;
    let lastRefresh = 0;
    let pending = false;
    let view = initial;

    const refresh = () => {
      if (document.hidden) {
        pending = true;
        return;
      }
      const wait = lastRefresh + REFRESH_INTERVAL_MS - Date.now();
      if (wait > 0) {
        throttle ??= setTimeout(() => {
          throttle = undefined;
          refresh();
        }, wait);
        return;
      }
      pending = false;
      lastRefresh = Date.now();
      // router.refresh() also drops the router's cached payloads of other routes: nothing skipped is left behind.
      view = { ...view, skipped: false };
      router.refresh();
    };
    const step = (signal: LiveSignal) => {
      const next = liveStep(view, signal);
      view = next.view;
      if (next.refresh) refresh();
    };
    const synced = (at: number | null | undefined) => {
      if (typeof at === "number") window.dispatchEvent(new CustomEvent(SYNCED_EVENT, { detail: { at } }));
    };
    const parse = <T,>(e: Event): Partial<T> => {
      try {
        return JSON.parse((e as MessageEvent<string>).data) ?? {};
      } catch {
        return {};
      }
    };

    const connect = () => {
      clearTimeout(reconnect);
      reconnect = undefined;
      const s = new EventSource("/api/live");
      source = s;
      s.onopen = () => setStatus("live");
      s.onerror = () => {
        setStatus("reconnecting");
        // The browser retries on its own unless the connection was refused outright.
        if (s.readyState === EventSource.CLOSED) {
          s.close();
          if (source === s) source = undefined;
          reconnect = setTimeout(() => {
            if (!document.hidden) connect();
          }, RECONNECT_MS);
        }
      };
      s.addEventListener("hello", (e) => {
        const d = parse<{ generation: number | null; at: number | null; health: SyncHealth }>(e);
        step({ kind: "hello", generation: d.generation ?? null, health: d.health });
        synced(d.at);
      });
      s.addEventListener("sync", (e) => {
        const d = parse<SyncEvent>(e);
        // Judged against the URL shown now; a navigation still in flight is caught by `skipped` when it lands.
        step({ kind: "sync", event: d, pathname: window.location.pathname, search: window.location.search });
        synced(syncedAt(d));
      });
      s.addEventListener("progress", (e) => {
        window.dispatchEvent(new CustomEvent(PROGRESS_EVENT, { detail: parse<{ files: number | null }>(e) }));
      });
    };
    const disconnect = () => {
      source?.close();
      source = undefined;
      clearTimeout(reconnect);
      reconnect = undefined;
    };
    const onVisibility = () => {
      if (document.hidden) {
        disconnect();
        return;
      }
      if (!source && reconnect === undefined) connect();
      if (pending) refresh();
    };

    navigated.current = () => step({ kind: "navigated" });
    if (!document.hidden) connect();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      navigated.current = () => {};
      disconnect();
      clearTimeout(throttle);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [router, initial]);

  const label = status === "reconnecting" ? "Reconnecting" : "Live";
  const title =
    status === "live"
      ? "Live: pages refresh when agents write new log entries"
      : status === "reconnecting"
        ? "Lost the live connection; retrying"
        : "Connecting to live updates";
  return (
    <>
      <span className="live" data-state={status} title={title} role="status">
        <span className="live-dot" aria-hidden="true" />
        {label}
      </span>
      {/* useSearchParams needs a Suspense boundary: the root layout also renders prerendered routes (not-found). */}
      <Suspense fallback={null}>
        <UrlChange onChange={navigated} />
      </Suspense>
    </>
  );
}

/** Calls `onChange` after every change of path or query, including Back and Forward. Renders nothing. */
function UrlChange({ onChange }: { onChange: React.RefObject<() => void> }) {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  useEffect(() => {
    // Also runs at mount, when nothing has been skipped yet: a no-op.
    onChange.current();
  }, [pathname, search, onChange]);
  return null;
}

/**
 * The relative time of the last successful sync ("just now", "3 min ago"). Starts from the server's render and then
 * follows the live stream's syncs (relayed by LiveRefresh) and the clock, so the top bar stays current on pages that
 * a sync does not refresh. `now` is the server's clock at render, so the first client render matches the HTML.
 */
export function SyncedAgo({ at, now: renderedNow }: { at: number; now: number }) {
  const [latest, setLatest] = useState(at);
  const [now, setNow] = useState(renderedNow);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const onSynced = (e: Event) => {
      const t = (e as CustomEvent<{ at?: number }>).detail?.at;
      if (typeof t !== "number") return;
      setLatest((l) => Math.max(l, t));
      tick();
    };
    tick();
    const timer = setInterval(tick, AGO_TICK_MS);
    window.addEventListener(SYNCED_EVENT, onSynced);
    return () => {
      clearInterval(timer);
      window.removeEventListener(SYNCED_EVENT, onSynced);
    };
  }, []);
  const shown = Math.max(at, latest);
  // Same machine, so the same clock and time zone; the guard covers the absolute date `ago` shows after a week.
  return <span suppressHydrationWarning>{ago(shown, Math.max(now, shown))}</span>;
}

/**
 * "N logs so far" while the first sync imports: starts from the server's count and follows the live stream's
 * `progress` events (relayed by LiveRefresh). The Suspense boundary around it swaps in the page when the import ends.
 */
export function ImportProgress({ files: initial }: { files: number | null }) {
  const [files, setFiles] = useState(initial);
  useEffect(() => {
    const onProgress = (e: Event) => {
      const n = (e as CustomEvent<{ files?: number | null }>).detail?.files;
      if (typeof n === "number") setFiles(n);
    };
    window.addEventListener(PROGRESS_EVENT, onProgress);
    return () => window.removeEventListener(PROGRESS_EVENT, onProgress);
  }, []);
  if (files === null) return <>Importing logs…</>;
  return (
    <>
      Importing logs… {files.toLocaleString("en-US")} {files === 1 ? "file" : "files"} so far
    </>
  );
}

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5V3.5A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5h2" />
    </svg>
  );
}

/** A shell command in a mono pill with a copy button. Falls back to selecting the text when the clipboard is unavailable. */
export function CopyCommand({ command, label = "Copy command" }: { command: string; label?: string }) {
  const ref = useRef<HTMLElement>(null);
  const [state, setState] = useState<"idle" | "copied" | "selected">("idle");

  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), 1800);
    return () => clearTimeout(t);
  }, [state]);

  const select = () => {
    const node = ref.current;
    const selection = window.getSelection();
    if (!node || !selection) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
    setState("selected");
  };
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(command);
      setState("copied");
    } catch {
      select();
    }
  };

  return (
    <span className="cmd">
      <code ref={ref} className="cmd-text" title={command}>
        {command}
      </code>
      <button type="button" className="cmd-copy" onClick={copy} aria-label={label} title={label}>
        <CopyIcon />
        <span aria-live="polite">{state === "copied" ? "Copied" : state === "selected" ? "Press Ctrl+C" : "Copy"}</span>
      </button>
    </span>
  );
}

/**
 * Tags of one session: manual chips with remove buttons, automatic chips (not removable; adding the same tag
 * manually pins it), and an input with suggestions from existing manual and automatic tags.
 */
export function TagEditor({
  sessionId,
  tags,
  autoTags,
  suggestions,
}: {
  sessionId: string;
  tags: string[];
  autoTags: AutoTag[];
  suggestions: { tag: string; count: number; auto: boolean }[];
}) {
  const [current, setCurrent] = useState(tags);
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const listId = useId();

  // Server data wins after each revalidation.
  useEffect(() => setCurrent(tags), [tags]);

  const query = text.trim().replace(/^#+/, "").toLowerCase();
  const matches = suggestions.filter((s) => !current.includes(s.tag) && s.tag.includes(query)).slice(0, 8);
  const showList = open && matches.length > 0;

  const add = (raw: string) => {
    if (!raw.trim()) return;
    setError(null);
    startTransition(async () => {
      const r = await addTag(sessionId, raw);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setCurrent((c) => (c.includes(r.tag) ? c : [...c, r.tag].sort()));
      setText("");
      setHighlight(-1);
    });
  };
  const remove = (tag: string) => {
    setError(null);
    setCurrent((c) => c.filter((t) => t !== tag));
    startTransition(async () => {
      const r = await removeTag(sessionId, tag);
      if (!r.ok) setError(r.error);
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      add(showList && highlight >= 0 ? matches[highlight].tag : text);
    } else if (e.key === "Backspace" && text === "" && current.length > 0) {
      e.preventDefault();
      remove(current[current.length - 1]);
    } else if (e.key === "ArrowDown" && matches.length) {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => (h + 1) % matches.length);
    } else if (e.key === "ArrowUp" && matches.length) {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => (h <= 0 ? matches.length - 1 : h - 1));
    } else if (e.key === "Escape") {
      setOpen(false);
      setHighlight(-1);
    }
  };

  return (
    <div className="tag-editor" aria-busy={pending || undefined}>
      {current.map((t) => (
        <span key={t} className="tag-chip">
          <Link href={`/sessions?tag=${encodeURIComponent(t)}`}>#{t}</Link>
          <button type="button" className="tag-remove" onClick={() => remove(t)} aria-label={`Remove tag ${t}`} title="Remove tag">
            ×
          </button>
        </span>
      ))}
      {autoTags
        .filter((t) => !current.includes(t.tag))
        .map((t) => (
          <AutoTagChip key={t.tag} {...t} />
        ))}
      <span className="tag-input-wrap">
        <input
          className="tag-input"
          type="text"
          value={text}
          placeholder={current.length ? "Add tag" : "Add a tag…"}
          aria-label="Add tag"
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList && highlight >= 0 ? `${listId}-${highlight}` : undefined}
          aria-invalid={error ? true : undefined}
          maxLength={41}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
            setHighlight(-1);
            setError(null);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
        />
        {showList && (
          <ul className="tag-suggestions" role="listbox" id={listId}>
            {matches.map((m, i) => (
              <li
                key={m.tag}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === highlight}
                // mousedown, not click: fires before the input's blur closes the list.
                onMouseDown={(e) => {
                  e.preventDefault();
                  add(m.tag);
                }}
              >
                #{m.tag} <span className="muted">{m.auto ? `auto · ${m.count}` : m.count}</span>
              </li>
            ))}
          </ul>
        )}
      </span>
      {error && (
        <span className="error-text tag-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

const KINDS = [
  { id: "user", label: "Prompts", color: "var(--kind-user)" },
  { id: "assistant", label: "Replies", color: "var(--kind-assistant)" },
  { id: "thinking", label: "Thinking", color: "var(--kind-thinking)" },
  { id: "tools", label: "Tools", color: "var(--kind-tool)" },
  { id: "system", label: "System", color: "var(--kind-system)" },
  { id: "error", label: "Errors", color: "var(--kind-error)" },
];

/**
 * Toggles which event types the timeline shows. The filter lives in the URL
 * (`?kinds=`) and is applied by the server, so paging runs over the matching
 * events only; `hrefs` holds each chip's toggled URL plus `all`.
 */
export function TimelineFilter({ counts, shown, hrefs }: { counts: Record<string, number>; shown: string[]; hrefs: Record<string, string> }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [optimistic, setOptimistic] = useOptimistic(shown);
  const go = (href: string, next: string[]) =>
    startTransition(() => {
      setOptimistic(next);
      router.push(href, { scroll: false });
    });
  const chips = KINDS.filter((k) => counts[k.id] || shown.includes(k.id));
  const all = chips.map((k) => k.id);
  return (
    <div className="timeline-controls" role="group" aria-label="Show event types" aria-busy={pending || undefined}>
      {chips.map((k) => {
        const on = optimistic.includes(k.id);
        return (
          <button
            key={k.id}
            type="button"
            className="chip"
            aria-pressed={on}
            onClick={() => go(hrefs[k.id], on ? optimistic.filter((x) => x !== k.id) : [...optimistic, k.id])}
          >
            <span className="ev-dot" style={{ background: k.color, marginTop: 0 }} />
            {k.label} <span className="muted">{counts[k.id] ?? 0}</span>
          </button>
        );
      })}
      {all.some((k) => !optimistic.includes(k)) && (
        <button type="button" className="chip" onClick={() => go(hrefs.all, all)}>
          Show all
        </button>
      )}
    </div>
  );
}
