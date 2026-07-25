// Gear inventory — what the library was actually shot with. Two aggregates over
// `assets`: one per camera body (EXIF Make+Model), one per lens (EXIF LensModel).
// Feeds the illustrated shelf on /gear.
//
// Both queries share the same scope:
//   - live assets only (`deleted_at IS NULL`), like every other counter in the
//     app, so a trashed frame stops inflating a body's tally;
//   - logical media (`group_role <> 'companion'`), so a RAW+JPEG pair counts as
//     one photo rather than two — same rule as /api/stats (cf. lib/pairing.ts).
//
// Grouping stays on the RAW EXIF string, never on the friendly label: it is the
// value the gallery filters on (`?device=` / `?lens=`), so a card's count and the
// grid it links to can't drift. Prettifying happens on the way out, for display
// only (cf. lib/cameraLabels.ts).
import { many } from "./db";
import { friendlyCameraName } from "./cameraLabels";
import type { GearCamera, GearLens } from "./gearTypes";

// Shared predicate for "a frame that counts" — see the scope note above.
const LIVE = `a.deleted_at IS NULL AND a.group_role IS DISTINCT FROM 'companion'`;

type Row = {
  name: string;
  count: number;
  photos: number;
  videos: number;
  first_capture: string | null;
  last_capture: string | null;
};

// Most frequent `pair` value per `key` — the top lens of a body, or the top body
// of a lens. DISTINCT ON keeps the first row of each key group, and the ORDER BY
// puts the biggest count there. One query per direction instead of a correlated
// subquery per card.
async function topPairs(
  key: "device" | "lens",
  pair: "device" | "lens",
): Promise<Map<string, string>> {
  const rows = await many<{ key: string; pair: string }>(
    `SELECT DISTINCT ON (a.${key}) a.${key} AS key, a.${pair} AS pair
     FROM assets a
     WHERE ${LIVE} AND a.${key} <> '' AND a.${pair} <> ''
       AND a.${key} IS NOT NULL AND a.${pair} IS NOT NULL
     GROUP BY a.${key}, a.${pair}
     ORDER BY a.${key}, count(*) DESC, a.${pair}`,
  );
  return new Map(rows.map((r) => [r.key, r.pair]));
}

export async function listCameras(): Promise<GearCamera[]> {
  const [rows, topLens] = await Promise.all([
    many<Row>(
      `SELECT a.device                                          AS name,
              count(*)::int                                     AS count,
              count(*) FILTER (WHERE a.media_type = 'photo')::int AS photos,
              count(*) FILTER (WHERE a.media_type = 'video')::int AS videos,
              min(a.captured_at)                                AS first_capture,
              max(a.captured_at)                                AS last_capture
       FROM assets a
       WHERE ${LIVE} AND a.device IS NOT NULL AND a.device <> ''
       GROUP BY a.device
       ORDER BY count DESC, a.device`,
    ),
    topPairs("device", "lens"),
  ]);

  return rows.map((r) => ({
    ...r,
    label: friendlyCameraName(r.name),
    top_lens: topLens.get(r.name) ?? null,
  }));
}

export async function listLenses(): Promise<GearLens[]> {
  const [rows, topBody] = await Promise.all([
    many<
      Row & {
        focal_min: number | null;
        focal_max: number | null;
        aperture_min: number | null;
      }
    >(
      // NULLIF(...,0): a few bodies write a 0 focal length / aperture when the
      // lens reports nothing electronically (adapted glass, most video files).
      // Left as-is they would flatten every range to "0mm" and draw every manual
      // lens the same size.
      `SELECT a.lens                                            AS name,
              count(*)::int                                     AS count,
              count(*) FILTER (WHERE a.media_type = 'photo')::int AS photos,
              count(*) FILTER (WHERE a.media_type = 'video')::int AS videos,
              min(a.captured_at)                                AS first_capture,
              max(a.captured_at)                                AS last_capture,
              min(NULLIF(a.focal_length, 0))                    AS focal_min,
              max(NULLIF(a.focal_length, 0))                    AS focal_max,
              min(NULLIF(a.aperture, 0))                        AS aperture_min
       FROM assets a
       WHERE ${LIVE} AND a.lens IS NOT NULL AND a.lens <> ''
       GROUP BY a.lens
       ORDER BY count DESC, a.lens`,
    ),
    topPairs("lens", "device"),
  ]);

  return rows.map((r) => ({
    ...r,
    top_body: topBody.get(r.name) ?? null,
  }));
}
