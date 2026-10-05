import { useSyncExternalStore } from "react";

/**
 * Decorative motion (the pixel band, stepped hover animations): the user's choice from the top bar, stored in
 * localStorage, else the system's reduced-motion setting. Client-only; the server snapshot is null (unknown).
 */
const KEY = "agent-monitor.motion";
const CHANGE = "agent-monitor:motion";
const REDUCED = "(prefers-reduced-motion: reduce)";

function stored(): "on" | "off" | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "on" || v === "off" ? v : null;
  } catch {
    return null;
  }
}

export function motionEnabled(): boolean {
  const choice = stored();
  return choice ? choice === "on" : !matchMedia(REDUCED).matches;
}

export function setMotion(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // Storage disabled: the choice lasts until reload.
  }
  window.dispatchEvent(new Event(CHANGE));
}

/** Calls `onChange` when the choice changes (this tab or another) or the system setting does. */
export function subscribeMotion(onChange: () => void): () => void {
  const media = matchMedia(REDUCED);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) onChange();
  };
  media.addEventListener("change", onChange);
  window.addEventListener(CHANGE, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    media.removeEventListener("change", onChange);
    window.removeEventListener(CHANGE, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export const useMotion = (): boolean | null => useSyncExternalStore(subscribeMotion, motionEnabled, () => null);
