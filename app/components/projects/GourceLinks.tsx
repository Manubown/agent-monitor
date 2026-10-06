import { GOURCE_HINT, gourceHref } from "./links";

/** Download links for a Gource log of a session tree (`session`) or a project (`project` plus page filters). */
export function GourceLinks({ params }: { params: Record<string, string | undefined> }) {
  return (
    <span className="export-links" role="group" aria-label="Gource export">
      <a className="btn" href={gourceHref(params)} download title={GOURCE_HINT}>
        Gource log
      </a>
      <a className="btn" href={gourceHref(params, true)} download title={`${GOURCE_HINT}\nReads included, in a dimmed colour.`}>
        + reads
      </a>
    </span>
  );
}
