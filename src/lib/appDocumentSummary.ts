// The summary a client may send beside a document (migration 0056): what a
// gallery card draws, so the list route can answer without the bodies. Pure —
// no database — so the PUT route's validation is unit-tested.
//
// Opaque like the body: Winnow checks its shape and size, never its content.

// A card needs a name, a few counts and a handful of ids. 16 KiB is ample and
// keeps a list of hundreds of documents in the tens of KB the gallery wants.
export const MAX_SUMMARY_BYTES = 16 * 1024;

export type SummaryRead =
  | { ok: true; summary: Record<string, unknown> | null }
  | { ok: false; status: 400 | 413; error: string };

/** The PUT body's `summary`: absent or null → null, an object within the cap → itself. */
export function readSummary(raw: unknown): SummaryRead {
  if (raw === undefined || raw === null) return { ok: true, summary: null };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, status: 400, error: "summary must be an object" };
  }
  if (Buffer.byteLength(JSON.stringify(raw), "utf8") > MAX_SUMMARY_BYTES) {
    return { ok: false, status: 413, error: `summary over ${MAX_SUMMARY_BYTES} bytes` };
  }
  return { ok: true, summary: raw as Record<string, unknown> };
}
