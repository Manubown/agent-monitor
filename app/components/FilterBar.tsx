"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

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

/** One row of filters above the content; every chart and table below reads the same URL params. */
export function FilterBar({ ranges, sources, projects, current, search }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [q, setQ] = useState(current.q ?? "");

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
          <Link key={r.value} href={href({ range: r.value })} aria-current={current.range === r.value ? "true" : undefined} scroll={false}>
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
    </div>
  );
}
