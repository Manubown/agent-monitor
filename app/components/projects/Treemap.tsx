import Link from "next/link";
import { sourceLabel } from "../../../src/adapters";
import { dominantSource, touches, type TreeCounts, type TreeDir, type TreeNode } from "../../../src/core/filetree";
import { integer } from "../../lib/format";
import { sourceColor } from "../ui";
import { nestedLayout } from "./treemap";
import "../../projects.css";

export type ColorMode = "ratio" | "source";

/** Layout space: x in arbitrary units (scaled to the box width), y in pixels of the default height. Areas stay proportional under the x scaling. */
const W = 1000;
const H = 560;

const LAYOUT = { depth: 3, header: 18, pad: 3, minOpen: 56, minBox: 3 };

/** Share of changes, as the mix between the read and the write series (same colours as the session graph). */
const ratioFill = (c: TreeCounts): string => {
  const pct = Math.round((c.changes / Math.max(1, touches(c))) * 100);
  return `color-mix(in oklab, var(--series-2) ${pct}%, var(--series-1))`;
};

export const fillFor = (c: TreeCounts, mode: ColorMode): string => {
  if (mode === "ratio") return ratioFill(c);
  const s = dominantSource(c);
  return s ? sourceColor(s) : "var(--series-8)";
};

function tooltip(n: TreeNode): string {
  const lines = [
    n.path || "(project root)",
    `${integer(touches(n))} touches: ${integer(n.reads)} reads, ${integer(n.changes)} changes`,
    Object.entries(n.sources)
      .sort((a, b) => b[1] - a[1])
      .map(([s, k]) => `${sourceLabel(s)} ${integer(k)}`)
      .join(" · "),
  ];
  if (n.kind === "dir") lines.splice(1, 0, `${integer(n.files)} files · click to open`);
  return lines.join("\n");
}

const pct = (v: number, of: number) => `${(v / of) * 100}%`;

/** Squarified treemap of `dir`: area = touches, nested three levels deep; directories drill down, files open the side panel. */
export function Treemap({
  dir,
  mode,
  selected,
  dirHref,
  fileHref,
}: {
  dir: TreeDir;
  mode: ColorMode;
  selected?: string;
  dirHref: (path: string) => string;
  fileHref: (path: string) => string;
}) {
  const boxes = nestedLayout<TreeNode>(dir, { x: 0, y: 0, w: W, h: H }, LAYOUT, touches, (n) => (n.kind === "dir" ? n.children : undefined));
  return (
    <div className="pm-treemap" role="group" aria-label={`File map of ${dir.path || "the project"}`}>
      {boxes.map(({ node, rect, open }) => {
        const style = { left: pct(rect.x, W), top: pct(rect.y, H), width: pct(rect.w, W), height: pct(rect.h, H) };
        const label = rect.w >= 44 && rect.h >= 15;
        if (node.kind === "dir") {
          return (
            <Link
              key={`d:${node.path}`}
              href={dirHref(node.path)}
              scroll={false}
              className={open ? "pm-box pm-dir pm-open" : "pm-box pm-dir"}
              style={open ? style : { ...style, background: fillFor(node, mode) }}
              title={tooltip(node)}
              aria-label={`Open ${node.path}: ${integer(node.files)} files, ${integer(touches(node))} touches`}
            >
              {label && (
                <span className="pm-label">
                  {node.name}/<span className="pm-count">{integer(touches(node))}</span>
                </span>
              )}
            </Link>
          );
        }
        return (
          <Link
            key={`f:${node.path}`}
            href={fileHref(node.path)}
            scroll={false}
            className={node.path === selected ? "pm-box pm-file pm-selected" : "pm-box pm-file"}
            style={{ ...style, background: fillFor(node, mode) }}
            title={tooltip(node)}
            aria-label={`${node.path}: ${integer(node.reads)} reads, ${integer(node.changes)} changes`}
            aria-current={node.path === selected ? "true" : undefined}
          >
            {label && (
              <span className="pm-label">
                {node.name}
                <span className="pm-count">{integer(touches(node))}</span>
              </span>
            )}
          </Link>
        );
      })}
    </div>
  );
}

/** Legend of the active colour mode. */
export function TreemapLegend({ mode, sources }: { mode: ColorMode; sources: string[] }) {
  if (mode === "source") {
    return (
      <span className="pm-legend">
        {sources.map((s) => (
          <span key={s}>
            <span className="swatch" style={{ background: sourceColor(s) }} />
            {sourceLabel(s)}
          </span>
        ))}
        <span className="muted">most touches</span>
      </span>
    );
  }
  return (
    <span className="pm-legend">
      <span>only reads</span>
      <span className="pm-ramp" aria-hidden="true">
        {[0, 25, 50, 75, 100].map((p) => (
          <span key={p} style={{ background: `color-mix(in oklab, var(--series-2) ${p}%, var(--series-1))` }} />
        ))}
      </span>
      <span>only changes</span>
    </span>
  );
}
