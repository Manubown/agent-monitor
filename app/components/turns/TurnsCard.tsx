import Link from "next/link";
import type { ActionCategory } from "../../../src/store/activity";
import type { Turn } from "../../../src/store/turns";
import { clock, duration, integer, tokens } from "../../lib/format";
import { CATEGORIES } from "../graph/categories";
import { Cost, Meter } from "../ui";
import "../../turns.css";

/** Tool categories in the order and colors of "What it did"; failed calls are in the Errors column. */
const TOOL_CATEGORIES = CATEGORIES.filter((c): c is { key: ActionCategory; label: string; color: string } => c.key !== "error");

/** One row per prompt of the session: what the agent tree did until the next prompt. */
export function TurnsCard({ sessionId, turns }: { sessionId: string; turns: Turn[] }) {
  const prompts = turns.filter((t) => t.prompt).length;
  const maxCalls = Math.max(1, ...turns.map((t) => t.toolCalls));
  const maxCost = Math.max(0, ...turns.map((t) => t.cost ?? 0));

  return (
    <section className="card">
      <div className="card-head">
        <h2>Turns</h2>
        <span className="muted">
          {prompts ? `${integer(prompts)} ${prompts === 1 ? "prompt" : "prompts"}` : "no prompts"} · each runs until the next; subagent work counts in the turn it ran in
        </span>
      </div>
      <div className="table-wrap">
        <table className="turns">
          <thead>
            <tr>
              <th className="num">#</th>
              <th>Prompt</th>
              <th className="num">Started</th>
              <th className="num" title="Working time: pauses over 10 minutes count only while a tool or subagent was running">
                Active
              </th>
              <th className="num">Requests</th>
              <th className="num">Tokens</th>
              <th className="num">Cost</th>
              <th className="num">Tool calls</th>
              <th className="num" title="Files written, edited, deleted or moved">
                Files
              </th>
              <th className="num">Errors</th>
              <th className="num">Subagents</th>
            </tr>
          </thead>
          <tbody>
            {turns.map((t) => {
              const mix = TOOL_CATEGORIES.filter((c) => t.tools[c.key] > 0);
              const errors = t.failedTools + t.errors;
              return (
                <tr key={t.n} className={t.prompt ? "row-click" : undefined}>
                  <td className="num muted">{t.n || "–"}</td>
                  <td className="turn-prompt">
                    {t.prompt ? (
                      <Link className="row-link" href={`/sessions/${encodeURIComponent(sessionId)}?at=${t.prompt.seq}#e-${t.prompt.seq}`} title={t.prompt.text}>
                        {t.prompt.text || "(empty prompt)"}
                      </Link>
                    ) : (
                      <span className="muted">{prompts ? "Before the first prompt" : "No prompt: the whole run"}</span>
                    )}
                  </td>
                  <td className="num muted">{clock(t.start)}</td>
                  <td className="num" title={`${duration(t.end - t.start)} wall clock`}>
                    {duration(t.activeMs)}
                  </td>
                  <td className="num">{integer(t.requests)}</td>
                  <td className="num" title={`${tokens(t.output)} output`}>
                    {tokens(t.tokens)}
                  </td>
                  <td className="num">
                    <Cost value={t.cost} source={t.costSource} />
                    <Meter value={t.cost ?? 0} max={maxCost} />
                  </td>
                  <td className="num" title={mix.map((c) => `${c.label} ${t.tools[c.key]}`).join(" · ") || undefined}>
                    {integer(t.toolCalls)}
                    <span className="turn-bar" aria-hidden="true">
                      <span className="turn-bar-fill" style={{ width: `${(t.toolCalls / maxCalls) * 100}%` }}>
                        {mix.map((c) => (
                          <span key={c.key} style={{ flexGrow: t.tools[c.key], background: c.color }} />
                        ))}
                      </span>
                    </span>
                  </td>
                  <td className={t.filesChanged ? "num" : "num muted"}>{integer(t.filesChanged)}</td>
                  <td
                    className={errors ? "num error-text" : "num muted"}
                    title={errors ? `${integer(t.failedTools)} failed tool calls · ${integer(t.errors)} failed model requests` : undefined}
                  >
                    {integer(errors)}
                  </td>
                  <td className={t.subagents ? "num" : "num muted"}>{integer(t.subagents)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="turn-legend muted" aria-hidden="true">
        {TOOL_CATEGORIES.map((c) => (
          <span key={c.key}>
            <span className="swatch" style={{ background: c.color }} />
            {c.label}
          </span>
        ))}
      </div>
    </section>
  );
}
