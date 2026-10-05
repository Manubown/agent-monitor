"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { TARGET_EVENT } from "./shared";
import "../../search.css";

/** How long to wait for a streamed page to render the target. */
const WAIT_MS = 4000;

/**
 * Deep links to timeline events (`/sessions/<id>#e-<seq>`): mark the target
 * (`:target` does not follow client-side navigation), open its <details> and
 * center it. Runs on load, on hashchange, on route changes and when the search
 * palette navigates.
 */
export function TargetEvent() {
  const pathname = usePathname();

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    /** `href` is "#e-<seq>" or "/sessions/<id>?at=<seq>#e-<seq>"; with a path, wait until the router has arrived there. */
    const seek = (href: string) => {
      clearTimeout(timer);
      const at = href.indexOf("#");
      const hash = at >= 0 ? href.slice(at) : "";
      const path = at > 0 ? decodeURIComponent(href.slice(0, at).split("?")[0]) : null;
      if (!hash.startsWith("#e-")) return;
      const id = decodeURIComponent(hash.slice(1));
      const deadline = Date.now() + WAIT_MS;
      const attempt = () => {
        if (cancelled) return;
        const arrived = !path || decodeURIComponent(window.location.pathname) === path;
        const el = arrived ? document.getElementById(id) : null;
        if (!el) {
          if (Date.now() < deadline) timer = window.setTimeout(attempt, 50);
          return;
        }
        for (const prev of document.querySelectorAll("[data-search-target]")) prev.removeAttribute("data-search-target");
        el.setAttribute("data-search-target", "");
        for (const details of el.querySelectorAll("details")) details.open = true;
        const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        el.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
      };
      attempt();
    };

    const onHash = () => seek(window.location.hash);
    const onTarget = (e: Event) => seek((e as CustomEvent<string>).detail);
    onHash();
    window.addEventListener("hashchange", onHash);
    window.addEventListener(TARGET_EVENT, onTarget);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener(TARGET_EVENT, onTarget);
    };
  }, [pathname]);

  return null;
}
