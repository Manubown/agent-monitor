import Link from "next/link";
import { adapters, sourceLabel } from "../../src/adapters";
import { project, usd } from "../lib/format";

/** Each tool keeps one categorical slot everywhere, in registry order, regardless of filters. */
export function sourceColor(source: string): string {
  const i = adapters.findIndex((a) => a.id === source);
  return `var(--series-${i >= 0 && i < 7 ? i + 1 : 8})`;
}

export function SourceBadge({ source }: { source: string }) {
  return (
    <span className="badge">
      <span className="swatch" style={{ background: sourceColor(source), marginRight: 0 }} />
      {sourceLabel(source)}
    </span>
  );
}

export function Tile({ label, value, note, hero }: { label: string; value: string; note?: React.ReactNode; hero?: boolean }) {
  return (
    <div className={hero ? "tile tile-hero" : "tile"}>
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value}</span>
      {note && <span className="tile-note">{note}</span>}
    </div>
  );
}

/** Cost with a hint when part of it is estimated or could not be priced. */
export function Cost({ value, source }: { value: number | null; source?: string }) {
  const hint =
    source === "estimated" || source === "mixed"
      ? "Estimated from list prices"
      : source === "partial"
        ? "Some models are unpriced; add them to pricing.json"
        : source === "unpriced"
          ? "Model not in the price table"
          : undefined;
  return (
    <span title={hint}>
      {usd(value)}
      {hint && <span className="muted">{source === "partial" || source === "unpriced" ? "*" : " ~"}</span>}
    </span>
  );
}

export function ProjectCell({ cwd }: { cwd: string | null }) {
  return (
    <span title={cwd ?? undefined}>
      <Link className="row-link" href={`/sessions?project=${encodeURIComponent(cwd ?? "")}`}>
        {project(cwd)}
      </Link>
    </span>
  );
}

export function Meter({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.max(2, (value / max) * 100) : 0;
  return (
    <span className="meter" aria-hidden="true">
      <span style={{ width: `${pct}%` }} />
    </span>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}

/** Manual tags as small chips linking to the sessions list filtered by that tag. */
export function TagList({ tags }: { tags: string[] }) {
  if (!tags.length) return null;
  return (
    <span className="tag-list">
      {tags.map((t) => (
        <Link key={t} className="tag" href={`/sessions?tag=${encodeURIComponent(t)}`}>
          #{t}
        </Link>
      ))}
    </span>
  );
}

/** Pulsing "something is running" marker; static under prefers-reduced-motion. */
export function PulseDot({ label = "Active" }: { label?: string }) {
  return <span className="pulse-dot" role="img" aria-label={label} />;
}

/** Download links for /api/export with the page's current filters; `compact` drops the "Export" prefix inside card heads. */
export function ExportLinks({ view, filters, compact }: { view: string; filters: Record<string, string | undefined>; compact?: boolean }) {
  const href = (format: string) => {
    const qs = new URLSearchParams({ view, format });
    for (const [k, v] of Object.entries(filters)) if (v) qs.set(k, v);
    return `/api/export?${qs}`;
  };
  return (
    <span className="export-links" role="group" aria-label={`Export ${view}`}>
      <a className="btn" href={href("csv")} download>
        {compact ? "CSV" : "Export CSV"}
      </a>
      <a className="btn" href={href("json")} download>
        JSON
      </a>
    </span>
  );
}
