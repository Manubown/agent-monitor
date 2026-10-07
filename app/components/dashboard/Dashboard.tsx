import Link from "next/link";
import { Fragment } from "react";
import { defaultLayout, HEIGHT_PX, hiddenWidgets, type Slot } from "../../../src/core/dashboard";
import { DayPanel } from "../DayPanel";
import { Empty } from "../ui";
import type { WidgetContext } from "./context";
import { AddWidget, ResetLayout, WidgetControls } from "./Controls";
import { DAY_CHART_IDS, WIDGET_SPECS } from "./specs";
import { WIDGETS } from "./widgets";
import "../../dashboard.css";

/**
 * The dashboard itself: the stored layout on a 12-column grid, one card per slot. The cards are server components
 * rendering their own queries; only the control frame around them in customize mode is client code.
 *
 * `?day=` panel: it belongs to the per-day charts, so it is rendered full width directly after the last per-day
 * chart the layout shows (with the default layout that is below the pair of charts, where it has always been). The
 * `#day-panel` anchor the chart columns link to therefore works in any layout — except when both per-day charts are
 * hidden, in which case nothing can open a day and the panel is not rendered at all.
 */
export function Dashboard({ ctx, layout, customize }: { ctx: WidgetContext; layout: readonly Slot[]; customize: boolean }) {
  const dayAfter = ctx.day === null ? -1 : layout.reduce((last, slot, i) => (DAY_CHART_IDS.some((id) => id === slot.id) ? i : last), -1);

  if (layout.length === 0) {
    return (
      <Empty>
        {customize
          ? "Every widget is hidden. Add one back from the bar above."
          : "Every widget is hidden. Open Filters at the right edge of the window and choose “Customize layout” to add one back."}
      </Empty>
    );
  }

  return (
    <div className="dash-grid">
      {layout.map((slot, i) => {
        const spec = WIDGET_SPECS.find((s) => s.id === slot.id);
        if (!spec) return null; // Normalization drops unknown ids; this only keeps the types honest.
        return (
          <Fragment key={slot.id}>
            <div className="dash-item" data-w={slot.w} style={{ "--dash-w": slot.w, "--dash-h": `${HEIGHT_PX[slot.h]}px` } as React.CSSProperties}>
              {customize && (
                <WidgetControls
                  id={spec.id}
                  title={spec.title}
                  w={slot.w}
                  h={slot.h}
                  widths={spec.widths}
                  heights={spec.heights}
                  index={i}
                  count={layout.length}
                />
              )}
              {WIDGETS[spec.id]({ ...ctx, height: HEIGHT_PX[slot.h] })}
            </div>
            {i === dayAfter && ctx.day && (
              <div className="dash-item" data-w={12} style={{ "--dash-w": 12 } as React.CSSProperties}>
                <DayPanel db={ctx.db} filters={ctx.filters} day={ctx.day} />
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

/** The bar between the band and the grid in customize mode: the way out, the hidden widgets and the way back to the
 * default layout. Outside that mode there is no bar; "Customize layout" is in the side panel (`SidePanel`). */
export function DashboardBar({ ctx, layout }: { ctx: WidgetContext; layout: readonly Slot[] }) {
  const hidden = hiddenWidgets(layout, WIDGET_SPECS);
  const changed = JSON.stringify(layout) !== JSON.stringify(defaultLayout(WIDGET_SPECS));

  return (
    <div className="dash-bar">
      <Link id="dash-done" className="btn" href={ctx.href({ customize: undefined })} scroll={false}>
        Done
      </Link>
      <AddWidget options={hidden.map((w) => ({ id: w.id, title: w.title, note: w.note }))} />
      <ResetLayout changed={changed} />
    </div>
  );
}
