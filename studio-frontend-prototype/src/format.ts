/* Small shared formatting/matching helpers.
 *
 * Extracted from App.tsx so the concept-v2 screens (projects.tsx, people.tsx)
 * can use them without importing the shell — which imports them back. */

/* `errText` lives in `problem.ts` with the rest of the error contract, and is
 * re-exported here because every screen already imports it from this module. */
export { errText } from "./problem";

/** Case-insensitive "does any of these fields contain the needle". */
export function matches(q: string, ...fields: (string | undefined | null)[]): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return fields.some((f) => (f ?? "").toLowerCase().includes(needle));
}

/** "8 min ago" / "2 hours ago" / "3 days ago" — the UPDATED column's vocabulary. */
export function relTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30);
  return `${months} month${months === 1 ? "" : "s"} ago`;
}

/** Two-letter avatar initials from a display name or username. */
export function initials(name: string): string {
  return name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}
