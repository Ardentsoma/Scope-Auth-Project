/**
 * Deterministic date formatting for server-rendered UI.
 *
 * `Date.prototype.toLocaleString()` with no arguments is a hydration bug in any
 * server-rendered component: it resolves against the *runtime* default, so Node
 * formats "26/09/2026, 10:52" while the browser formats "9/26/2026, 10:52 AM".
 * React then sees a text mismatch and throws a hydration error.
 *
 * The fix is to stop letting the runtime choose. Pinning BOTH the locale and
 * the timeZone means the output is a pure function of the timestamp, identical
 * on the server and in the browser, so the markup matches and there is nothing
 * to re-render.
 *
 * Timestamps are stored and returned as ISO-8601 UTC. Formatting in UTC keeps
 * this a pure function of the input; a user's local wall-clock time would make
 * the rendered string depend on where the browser happens to be, which is the
 * same class of problem one level down.
 */
const TIMESTAMP_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

const DATE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** e.g. "26 Sept 2026, 10:52". Invalid input yields an em dash, never "Invalid Date". */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return TIMESTAMP_FORMAT.format(date);
}

/** e.g. "26 Sept 2026". */
export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return DATE_FORMAT.format(date);
}
