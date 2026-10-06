"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useId, useOptimistic, useRef, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import type { AutoTag } from "../../src/core/autotags";
import { addTag, removeTag } from "../actions";
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

/**
 * Subscribes to /api/live and re-renders the current page when a sync wrote
 * something: at most once per 2 s, and only while the tab is visible (a hidden
 * tab refreshes once when it becomes visible again).
 */
export function LiveRefresh() {
  const router = useRouter();
  const [status, setStatus] = useState<"connecting" | "live" | "reconnecting">("connecting");

  useEffect(() => {
    let source: EventSource | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let throttle: ReturnType<typeof setTimeout> | undefined;
    let lastRefresh = 0;
    let pending = false;
    let generation: number | null | undefined;

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
      router.refresh();
    };
    const onVisible = () => {
      if (!document.hidden && pending) refresh();
    };
    const parse = (e: Event): { generation?: number | null; changed?: number } => {
      try {
        return JSON.parse((e as MessageEvent<string>).data);
      } catch {
        return {};
      }
    };

    const connect = () => {
      source = new EventSource("/api/live");
      source.onopen = () => setStatus("live");
      source.onerror = () => {
        setStatus("reconnecting");
        // The browser retries on its own unless the connection was refused outright.
        if (source?.readyState === EventSource.CLOSED) {
          source.close();
          reconnect = setTimeout(connect, RECONNECT_MS);
        }
      };
      source.addEventListener("hello", (e) => {
        const d = parse(e);
        // Syncs may have landed while we were disconnected.
        if (generation !== undefined && d.generation !== generation) refresh();
        generation = d.generation ?? null;
      });
      source.addEventListener("sync", (e) => {
        const d = parse(e);
        generation = d.generation ?? generation;
        if ((d.changed ?? 0) > 0) refresh();
      });
    };

    connect();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      source?.close();
      clearTimeout(reconnect);
      clearTimeout(throttle);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [router]);

  const label = status === "reconnecting" ? "Reconnecting" : "Live";
  const title =
    status === "live"
      ? "Live: pages refresh when agents write new log entries"
      : status === "reconnecting"
        ? "Lost the live connection; retrying"
        : "Connecting to live updates";
  return (
    <span className="live" data-state={status} title={title} role="status">
      <span className="live-dot" aria-hidden="true" />
      {label}
    </span>
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
