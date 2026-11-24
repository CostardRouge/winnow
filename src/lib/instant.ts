// pg hands a timestamptz back as its own text form — db.ts keeps it a string,
// "2025-03-10 09:00:00.123456+00" — which is NOT ISO 8601: a route that
// validates an instant with zod's `datetime()` refuses it, and Safari's
// Date.parse answers NaN. Inside the server that text is fine (the derivations
// compare it as strings against other pg text, which only works while both
// sides share the form), so it is converted where an instant LEAVES for a
// client that will parse it or send it back. Client-safe, no imports.

/**
 * The canonical ISO form ("…T09:00:00.123Z") of an instant in pg's text form
 * (or any form Date.parse reads). ISO carries milliseconds and pg
 * microseconds, so the rounding is chosen by what the instant bounds: `floor`
 * for the START of a range (the default — truncation), `ceil` for its END, so
 * the range still contains a last frame captured at 09:00:00.123456.
 * Throws on text that is not an instant: a silent "Invalid Date" travelling to
 * a client is the bug this exists to remove.
 */
export function isoInstant(text: string, round: "floor" | "ceil" = "floor"): string {
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) throw new RangeError(`Not an instant: ${text}`);
  // Date.parse keeps three fractional digits; anything past them was cut.
  const frac = /:\d{2}\.(\d+)/.exec(text)?.[1] ?? "";
  const cut = round === "ceil" && /[1-9]/.test(frac.slice(3));
  return new Date(cut ? ms + 1 : ms).toISOString();
}
