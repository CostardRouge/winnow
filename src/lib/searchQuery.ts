// What GET /api/search reads from its query string, bounded — pure, so the
// paging rules are tested without a database or an ML container.
//
// The ranking is a flat scan over asset_clip (route.ts), so every request
// already orders the whole library; what a client pays for is the grid
// projection of the rows it takes. A page is therefore capped (MAX_LIMIT) and
// a client that wants more asks the next one with `offset` — Atelier's Mosaic
// takes thousands of a description's closest (2026-11-05), the Search page
// sixty. `capabilities.search` announces both numbers.

export const DEFAULT_LIMIT = 60;
/** The most rows one page returns. Raised from 200 when paging arrived: a page of 1 000 grid rows is a few MB of JSON. */
export const MAX_LIMIT = 1000;
/** How deep a client may page into the ranking — far past any library this instance is sized for (~100k, `ARCHITECTURE-REVIEW.md`). */
export const MAX_OFFSET = 1_000_000;

export type SearchSource = "incoming" | "gallery" | null;

export type SearchQuery =
  | { ok: true; q: string; limit: number; offset: number; source: SearchSource }
  | { ok: false; error: string };

/** Read `q`, `limit`, `offset` and `source`; a bad number falls back to its default, a bad text is refused. */
export function readSearchQuery(sp: URLSearchParams): SearchQuery {
  const q = (sp.get("q") ?? "").trim();
  if (!q) return { ok: false, error: "q (the search text) is required" };
  if (q.length > 300) return { ok: false, error: "q is too long (max 300 chars)" };
  const limit = Math.min(Math.max(Number.parseInt(sp.get("limit") ?? "", 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offsetRaw = Number.parseInt(sp.get("offset") ?? "", 10);
  const offset = Number.isFinite(offsetRaw) ? Math.min(Math.max(offsetRaw, 0), MAX_OFFSET) : 0;
  // "all" (the third LibrarySource option, cf. LibrarySourceTabs.tsx) and any
  // unrecognized value both behave like "omitted" — the whole library —
  // rather than erroring, so a stale/garbled query string can't break search.
  const sourceParam = sp.get("source");
  const source: SearchSource = sourceParam === "incoming" || sourceParam === "gallery" ? sourceParam : null;
  return { ok: true, q, limit, offset, source };
}

/** The offset of the next page, or null when this one was the last (it came back short). */
export function nextOffset(offset: number, limit: number, returned: number): number | null {
  return returned < limit ? null : offset + returned;
}
