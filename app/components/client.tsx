"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { addTag, removeTag } from "../actions";
import "../features.css";

export function Nav() {
  const pathname = usePathname();
  const links = [
    { href: "/", label: "Overview", active: pathname === "/" },
    { href: "/sessions", label: "Sessions", active: pathname.startsWith("/sessions") },
    { href: "/usage", label: "Usage windows", active: pathname.startsWith("/usage") },
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

/** Manual tags of one session: chips with remove buttons and an input with suggestions from existing tags. */
export function TagEditor({ sessionId, tags, suggestions }: { sessionId: string; tags: string[]; suggestions: { tag: string; count: number }[] }) {
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
                #{m.tag} <span className="muted">{m.count}</span>
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

/** Toggles which event kinds the timeline shows; filtering is pure CSS on the server-rendered list. */
export function TimelineFilter({ counts, children }: { counts: Record<string, number>; children: React.ReactNode }) {
  const [hidden, setHidden] = useState<string[]>(["thinking", "system"]);
  const toggle = (id: string) => setHidden((h) => (h.includes(id) ? h.filter((k) => k !== id) : [...h, id]));
  return (
    <>
      <div className="timeline-controls" role="group" aria-label="Show event types">
        {KINDS.filter((k) => counts[k.id]).map((k) => (
          <button key={k.id} type="button" className="chip" aria-pressed={!hidden.includes(k.id)} onClick={() => toggle(k.id)}>
            <span className="ev-dot" style={{ background: k.color, marginTop: 0 }} />
            {k.label} <span className="muted">{counts[k.id]}</span>
          </button>
        ))}
      </div>
      <div className="timeline" data-hide={hidden.join(" ")}>
        {children}
      </div>
    </>
  );
}
