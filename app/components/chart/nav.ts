/**
 * Keyboard navigation of a bar chart's columns. The chart is one tab stop, so the arrow keys move the reading
 * position instead of the focus; pure, so the rules are testable without a DOM.
 */

/**
 * The column a key moves to, or null when the key is none of ours and must stay with the page. Right and Down step
 * forward, Left and Up step back, Home and End jump to the ends. Without a column yet, forward starts at the first
 * and back at the last. Steps stop at the ends rather than wrapping.
 */
export function columnForKey(key: string, active: number | null, count: number): number | null {
  if (count <= 0) return null;
  const last = count - 1;
  const at = active === null || active < 0 || active > last ? null : active;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return at === null ? 0 : Math.min(last, at + 1);
    case "ArrowLeft":
    case "ArrowUp":
      return at === null ? last : Math.max(0, at - 1);
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return null;
  }
}
