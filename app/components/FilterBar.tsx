"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { dayRangeLabel } from "../lib/format";

interface Option {
  value: string;
  label: string;
}

interface Props {
  ranges: Option[];
  sources: Option[];
  projects: Option[];
  /** Current query string values. */
  current: Record<string, string | undefined>;
  search?: boolean;
}

/** The filters every chart and table on a page reads from the same URL params: a row above the content, or on the
 * overview the side panel at the window's edge, which stacks it (`SidePanel`). */
export function FilterBar({ ranges, sources, projects, current, search }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [q, setQ] = useState(current.q ?? "");
  // A custom from/to window (a day drilled into from a chart) replaces the range, so no range button is current.
  const custom = dayRangeLabel(current.from, current.to);

  const href = (changes: Record<string, string | undefined>) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...current, ...changes, page: undefined })) if (v) params.set(k, v);
    const qs = params.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  };

  useEffect(() => {
    if (!search || q === (current.q ?? "")) return;
    const t = setTimeout(() => router.replace(href({ q: q || undefined })), 300);
    return () => clearTimeout(t);
  }, [q]); // only the typed text should trigger navigation

  return (
    <div className="filters">
      <nav className="segmented" aria-label="Time range">
        {ranges.map((r) => (
          <Link
            key={r.value}
            // Picking a range leaves the custom window: the two cannot both describe the time scope.
            href={href({ range: r.value, from: undefined, to: undefined, day: undefined })}
            aria-current={!custom && current.range === r.value ? "true" : undefined}
            scroll={false}
          >
            {r.label}
          </Link>
        ))}
      </nav>
      <select className="select" aria-label="Tool" value={current.source ?? ""} onChange={(e) => router.push(href({ source: e.target.value || undefined }), { scroll: false })}>
        <option value="">All tools</option>
        {sources.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
      <select className="select" aria-label="Project" value={current.project ?? ""} onChange={(e) => router.push(href({ project: e.target.value || undefined }), { scroll: false })}>
        <option value="">All projects</option>
        {projects.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
      </select>
      {search && <input className="search" type="search" placeholder="Search title, directory, id…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search sessions" />}
      {current.tag && (
        <span className="filter-chip">
          #{current.tag}
          <Link href={href({ tag: undefined })} aria-label={`Remove tag filter ${current.tag}`} title="Remove tag filter" scroll={false}>
            ×
          </Link>
        </span>
      )}
      {custom && (
        <span className="filter-chip">
          {custom}
          <Link
            href={href({ from: undefined, to: undefined, day: undefined })}
            aria-label={`Remove the custom range ${custom}`}
            title="Back to the time range"
            scroll={false}
          >
            ×
          </Link>
        </span>
      )}
    </div>
  );
}
