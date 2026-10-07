"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import "../../dashboard.css";

interface Props {
  /** How many filters narrow the page beyond its time range (tool, project, tag, search, custom window). */
  active: number;
  customize: boolean;
  /** Enters or leaves customize mode; absent when there is no dashboard to customize. */
  customizeHref?: string;
  /** The filter bar. */
  children: React.ReactNode;
}

/**
 * The overview's filters and its "Customize" toggle, folded into a drawer behind a tab on the right edge of the window
 * so they take no room above the dashboard. The tab's badge counts the active filters, which are otherwise out of
 * sight. Not modal: the dashboard behind it updates as a filter changes, and the drawer stays open across those
 * navigations (the page re-renders, this component keeps its state). The tab, the close button, Escape, a click
 * outside or focus moving out to the page closes it.
 *
 * Customize mode has its own bar above the grid (`DashboardBar`), so entering it closes the drawer. Both ways in and
 * out of that mode remove the focused control (the drawer hides, "Done" unmounts), so once the mode has changed,
 * focus that was lost goes to the counterpart: "Done" after entering, this tab after leaving.
 */
export function SidePanel({ active, customize, customizeHref, children }: Props) {
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const tab = useRef<HTMLButtonElement>(null);
  const mode = useRef(customize);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const outside = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!panel.current?.contains(target) && !tab.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  useEffect(() => {
    if (mode.current === customize) return;
    mode.current = customize;
    const focused = document.activeElement;
    if (focused && focused !== document.body && !panel.current?.contains(focused)) return;
    (customize ? document.getElementById("dash-done") : tab.current)?.focus();
  }, [customize]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape") return;
    // Escape in a filled search box clears it first, as the browser does; the next one closes the drawer.
    if (e.target instanceof HTMLInputElement && e.target.type === "search" && e.target.value) return;
    e.preventDefault();
    setOpen(false);
    tab.current?.focus();
  };

  return (
    <>
      <button
        ref={tab}
        type="button"
        className="side-tab"
        aria-expanded={open}
        aria-controls={id}
        aria-label={active ? `Filters and layout, ${active} active` : "Filters and layout"}
        data-active={active > 0 || undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKeyDown}
      >
        <span className="side-tab-label">Filters</span>
        {active > 0 && <span className="side-tab-count">{active}</span>}
      </button>
      <div
        ref={panel}
        id={id}
        className="side-panel"
        role="dialog"
        aria-modal="false"
        aria-label="Filters and layout"
        tabIndex={-1}
        data-open={open || undefined}
        // Tabbing past the last control leaves for the page underneath, so the drawer gets out of its way.
        onBlur={(e) => {
          const next = e.relatedTarget;
          if (next instanceof Node && !panel.current?.contains(next) && !tab.current?.contains(next)) setOpen(false);
        }}
        onKeyDown={onKeyDown}
      >
        <div className="side-head">
          <h2>Filters</h2>
          <button
            type="button"
            className="side-close"
            aria-label="Close filters and layout"
            onClick={() => {
              setOpen(false);
              tab.current?.focus();
            }}
          >
            ×
          </button>
        </div>
        {children}
        {customizeHref && (
          <section className="side-section">
            <h2>Dashboard</h2>
            <p className="muted">Move, resize, hide or add cards.</p>
            <Link className="btn" href={customizeHref} scroll={false} onClick={() => setOpen(false)}>
              {customize ? "Done customizing" : "Customize layout"}
            </Link>
          </section>
        )}
      </div>
    </>
  );
}
