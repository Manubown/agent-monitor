"use client";

import { useEffect, useTransition } from "react";
import { type Height, HEIGHT_LABEL, type LayoutEdit, type Width } from "../../../src/core/dashboard";
import { updateDashboard } from "../../actions";

/**
 * The only client components of the dashboard: the frame around each card in customize mode, the list of hidden
 * widgets and the reset button. The cards themselves stay server components — they are passed in as children of the
 * grid, which never re-renders here. Every control is a button with an accessible name and sends one edit (never a
 * layout) to `updateDashboard`, which validates it against the registry.
 *
 * After an edit the server re-renders the whole grid, so the button that was clicked is a new DOM node and the
 * browser would drop focus to the body. `pendingFocus` carries the ids to try, best first, over that re-render; the
 * effect below runs in every control after the new tree is committed and focuses the first one that is there and
 * enabled. A button that became impossible (moving the new first card earlier) hands focus to its neighbour.
 */
let pendingFocus: string[] | null = null;

/** Stable element ids, so focus can be restored across a server re-render. */
export const controlId = (action: string, widget: string): string => `dash-${action}-${widget}`;

function useFocusAfterEdit(): void {
  useEffect(() => {
    if (!pendingFocus) return;
    const ids = pendingFocus;
    // One attempt per commit: every control runs this effect on the same committed tree.
    pendingFocus = null;
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el instanceof HTMLElement && !(el instanceof HTMLButtonElement && el.disabled)) {
        el.focus();
        return;
      }
    }
  });
}

/** Sends one edit and remembers where focus should land once the new layout is on screen. */
function useEdit(): [(edit: LayoutEdit, focus: string[]) => void, boolean] {
  const [pending, startTransition] = useTransition();
  const run = (edit: LayoutEdit, focus: string[]) =>
    startTransition(async () => {
      await updateDashboard(edit);
      pendingFocus = focus;
    });
  return [run, pending];
}

interface ControlsProps {
  id: string;
  title: string;
  w: Width;
  h: Height;
  widths: readonly Width[];
  heights: readonly Height[];
  /** Position in the layout, for the disabled ends and for where focus goes after a move. */
  index: number;
  count: number;
}

export function WidgetControls({ id, title, w, h, widths, heights, index, count }: ControlsProps) {
  const [edit, pending] = useEdit();
  useFocusAfterEdit();
  const earlier = controlId("earlier", id);
  const later = controlId("later", id);

  return (
    <div className="dash-controls" role="group" aria-label={`Customize ${title}`} aria-busy={pending || undefined}>
      <span className="dash-ctl-name">{title}</span>
      <button
        type="button"
        id={earlier}
        className="dash-ctl"
        disabled={index === 0}
        aria-label={`Move ${title} earlier`}
        // Moving to the front disables this button, so focus goes to the other half of the pair.
        onClick={() => edit({ kind: "move", id, by: -1 }, index === 1 ? [later, earlier] : [earlier, later])}
      >
        ← Earlier
      </button>
      <button
        type="button"
        id={later}
        className="dash-ctl"
        disabled={index === count - 1}
        aria-label={`Move ${title} later`}
        onClick={() => edit({ kind: "move", id, by: 1 }, index === count - 2 ? [earlier, later] : [later, earlier])}
      >
        Later →
      </button>
      {widths.length > 1 && (
        <span className="dash-ctl-set" role="group" aria-label={`${title} width`}>
          {widths.map((n) => (
            <button
              key={n}
              type="button"
              id={controlId(`w${n}`, id)}
              className="dash-ctl"
              aria-pressed={n === w}
              aria-label={`${title} width ${n} of 12 columns`}
              onClick={() => edit({ kind: "width", id, w: n }, [controlId(`w${n}`, id)])}
            >
              {n}
            </button>
          ))}
        </span>
      )}
      {heights.length > 1 && (
        <span className="dash-ctl-set" role="group" aria-label={`${title} height`}>
          {heights.map((preset) => (
            <button
              key={preset}
              type="button"
              id={controlId(`h${preset}`, id)}
              className="dash-ctl"
              aria-pressed={preset === h}
              aria-label={`${title} height ${HEIGHT_LABEL[preset]}`}
              onClick={() => edit({ kind: "height", id, h: preset }, [controlId(`h${preset}`, id)])}
            >
              {preset}
            </button>
          ))}
        </span>
      )}
      <button
        type="button"
        id={controlId("hide", id)}
        className="dash-ctl dash-ctl-end"
        aria-label={`Hide ${title}`}
        // The widget moves to the "Add widget" list, which is where its controls continue.
        onClick={() => edit({ kind: "hide", id }, [controlId("add", id), "dash-reset"])}
      >
        Hide
      </button>
    </div>
  );
}

/** The widgets the layout does not show; adding one appends it at its default size. */
export function AddWidget({ options }: { options: { id: string; title: string; note: string }[] }) {
  const [edit, pending] = useEdit();
  useFocusAfterEdit();
  if (options.length === 0) return <span className="muted">Every widget is on the dashboard.</span>;

  return (
    <div className="dash-add" role="group" aria-label="Add widget" aria-busy={pending || undefined}>
      <span className="dash-ctl-name">Add widget</span>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          id={controlId("add", o.id)}
          className="dash-ctl"
          title={o.note}
          aria-label={`Add ${o.title}`}
          // The card is appended, so its "later" is the disabled end: focus the controls it does have.
          onClick={() => edit({ kind: "add", id: o.id }, [controlId("earlier", o.id), controlId("hide", o.id)])}
        >
          + {o.title}
        </button>
      ))}
    </div>
  );
}

/** `changed` is false for the default layout, where there is nothing to reset. */
export function ResetLayout({ changed }: { changed: boolean }) {
  const [edit, pending] = useEdit();
  useFocusAfterEdit();
  return (
    <button
      type="button"
      id="dash-reset"
      className="dash-ctl"
      disabled={!changed}
      aria-busy={pending || undefined}
      aria-label="Reset the dashboard to the default layout"
      // Resetting disables this button; focus then goes to the toggle that leaves customize mode.
      onClick={() => edit({ kind: "reset" }, ["dash-reset", "dash-done"])}
    >
      Reset to default
    </button>
  );
}
