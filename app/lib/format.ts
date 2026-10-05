const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat("en-US");

/** 1,284 / 12.9K / 4.2M */
export const tokens = (n: number): string => (Math.abs(n) < 10_000 ? whole.format(Math.round(n)) : compact.format(n));

export const integer = (n: number): string => whole.format(Math.round(n));

export const usd = (n: number | null | undefined): string => {
  if (n === null || n === undefined) return "—";
  if (n === 0) return "$0";
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  if (Math.abs(n) < 1000) return `$${n.toFixed(2)}`;
  return `$${compact.format(n)}`;
};

export const duration = (ms: number): string => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
};

/** A bin length as the unit of a rate: "hour", "3 hours", "10 min", "30 s". */
export const per = (ms: number): string => {
  const [n, unit, units] =
    ms % 86400_000 === 0
      ? [ms / 86400_000, "day", "days"]
      : ms % 3600_000 === 0
        ? [ms / 3600_000, "hour", "hours"]
        : ms % 60_000 === 0
          ? [ms / 60_000, "minute", "min"]
          : [ms / 1000, "second", "s"];
  return n === 1 ? unit : `${n} ${units}`;
};

export const ago = (ts: number, now = Date.now()): string => {
  const d = now - ts;
  if (d < 60_000) return "just now";
  if (d < 3600_000) return `${Math.floor(d / 60_000)} min ago`;
  if (d < 86400_000) return `${Math.floor(d / 3600_000)} h ago`;
  if (d < 7 * 86400_000) return `${Math.floor(d / 86400_000)} d ago`;
  return dateTime(ts);
};

export const dateTime = (ts: number): string =>
  new Date(ts).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

export const clock = (ts: number): string => new Date(ts).toLocaleTimeString("en-GB", { hour12: false });

/** "/home/me/Work/acme/web-app" -> "acme/web-app" */
export const project = (cwd: string | null | undefined): string => {
  if (!cwd) return "(no directory)";
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("/") || cwd;
};

export const shortDay = (day: string): string => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
};

/** Local calendar days from `first` to `last` inclusive, as YYYY-MM-DD. */
export const dayRange = (first: string, last: string): string[] => {
  const days: string[] = [];
  const [y, m, d] = first.split("-").map(Number);
  const cursor = new Date(y, m - 1, d);
  for (let i = 0; i < 3660; i++) {
    const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(cursor.getDate()).padStart(2, "0")}`;
    days.push(key);
    if (key >= last) break;
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
};

export const localDay = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
