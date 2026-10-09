// The gallery map's markers: located media grouped per ~1 m spot (the
// coordinate rounded to 5 decimals), each with its count and its newest media.
// Served by GET /api/assets/geo?by=place — the route's header carries the why:
// the per-media points stop at 10 000 newest-first, which on a 77 670-media
// library left the map showing nine months and made every bulk placement push
// older media off it. Bulk placement writes one coordinate per folder, so the
// same library is ~18 000 spots, and grouping on the exact coordinate is
// lossless — nothing is sampled, a spot's `n` is every media at it.
import { tx } from "./db";
import { buildFilter, type PartialAssetFilter } from "./filter";

/** Distinct spots, not media. Past it, the newest spots are kept. */
export const PLACE_CAP = 60000;

export type GeoPlace = {
  /** The newest media at the spot — what the marker's popover shows. */
  id: number;
  lat: number;
  lon: number;
  /** Media at the spot; omitted when 1. */
  n?: number;
  /** The newest media is a clip; omitted on a photo. */
  video?: true;
};

export async function geoPlaces(
  filter: PartialAssetFilter,
  cap = PLACE_CAP,
): Promise<{ places: GeoPlace[]; media: number; truncated: boolean }> {
  const { conditions, params } = buildFilter(filter, 1);
  conditions.push(`a.gps_lat IS NOT NULL`);
  const idx = params.length + 1;

  // One scan over the filtered rows with JIT off: the rule for an aggregate
  // that can span the whole library (docs/memory/database.md). The ratings
  // join is there because buildFilter's verdict/star conditions read `r`.
  const rows = await tx(async (client) => {
    await client.query("SET LOCAL jit = off");
    const res = await client.query<{
      id: number;
      media_type: "photo" | "video";
      lat: number;
      lon: number;
      n: number;
    }>(
      `SELECT (array_agg(a.id ORDER BY a.captured_at DESC NULLS LAST, a.id DESC))[1]::int AS id,
              (array_agg(a.media_type ORDER BY a.captured_at DESC NULLS LAST, a.id DESC))[1] AS media_type,
              round(a.gps_lat::numeric, 5)::float8 AS lat,
              round(a.gps_lon::numeric, 5)::float8 AS lon,
              count(*)::int AS n
       FROM assets a
       LEFT JOIN ratings r ON r.asset_id = a.id
       WHERE ${conditions.join(" AND ")}
       GROUP BY 3, 4
       ORDER BY max(a.captured_at) DESC NULLS LAST, 1 DESC
       LIMIT $${idx}`,
      [...params, cap + 1] as never[],
    );
    return res.rows;
  });

  const truncated = rows.length > cap;
  let media = 0;
  const places = (truncated ? rows.slice(0, cap) : rows).map(
    ({ id, lat, lon, n, media_type }) => {
      media += n;
      const p: GeoPlace = { id, lat, lon };
      // Both keys are omitted at their common value: at tens of thousands of
      // spots, a key repeated on every one is payload paid on each filter.
      if (n > 1) p.n = n;
      if (media_type === "video") p.video = true;
      return p;
    },
  );
  return { places, media, truncated };
}
