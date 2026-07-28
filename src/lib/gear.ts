// Gear inventory — what the library was actually shot with, as a body → glass
// tree: one entry per camera body (EXIF Make+Model), each carrying the lenses
// (EXIF LensModel) its frames were taken with. Feeds the illustrated shelf on
// /gear.
//
// Scope rules, shared by every tally here:
//   - live assets only (`deleted_at IS NULL`), like every other counter in the
//     app, so a trashed frame stops inflating a body's tally;
//   - logical media (`group_role <> 'companion'`), so a RAW+JPEG pair counts as
//     one photo rather than two — same rule as /api/stats (cf. lib/pairing.ts);
//   - only roots the Library can actually show: 'source'/'inbox' (Incoming) and
//     'finals' (Gallery). An 'export' root belongs to neither tab (cf.
//     lib/roles.ts), so its frames would count towards a grid you cannot open.
//
// Counts are kept SPLIT per source rather than merged: the same body usually has
// frames both in Incoming and in the Gallery, and the shelf links each card to
// one of those two grids. A merged total would promise media the linked grid
// doesn't hold — the "card says 400, grid says 3" mismatch.
//
// The SQL groups on the RAW EXIF strings, never on a friendly label: they are
// the values the gallery filters on (`?device=` / `?lens=`), so a card's count
// and the grid it links to can't drift. Prettifying happens on the way out, for
// display only (cf. lib/cameraLabels.ts).
//
// Lenses then get one extra fold in JS, because the raw string is not stable
// across bodies: the same glass arrives as "FE 50mm F1.4 GM" from one camera and
// "Sony FE 50mm F1.4 GM (SEL50F14GM)" from another, and drawing it twice with
// half the count each is simply wrong. Spellings that mean the same lens merge
// on `lensKey()`, and the card keeps ALL of them so it can still filter on the
// raw values (`?lens=a,b`) — the count/grid guarantee holds either way.
import { many } from "./db";
import { friendlyCameraName } from "./cameraLabels";
import { friendlyLensName, lensKey } from "./lensLabels";
import {
  EMPTY_STATS,
  type GearCamera,
  type GearLens,
  type GearSource,
  type GearStats,
} from "./gearTypes";

type Row = {
  device: string;
  /** '' when the file carries no lens tag (fixed-lens bodies, most video). */
  lens: string;
  source: GearSource;
  count: number;
  photos: number;
  videos: number;
  first_capture: string | null;
  last_capture: string | null;
  focal_min: number | null;
  focal_max: number | null;
  aperture_min: number | null;
};

// One pass over the live assets, grouped by (body, lens, source). Everything the
// shelf shows — the per-source tallies, the date spans, the focal/aperture range
// of each lens ON that body — falls out of this single aggregate; the tree is
// then assembled in JS, where summing a body's lenses is free.
//
// NULLIF(...,0): a few bodies write a 0 focal length / aperture when the lens
// reports nothing electronically (adapted glass, most video files). Left as-is
// they would flatten every range to "0mm" and draw every manual lens the same
// size.
const GEAR_SQL = `
  SELECT a.device                                            AS device,
         COALESCE(a.lens, '')                                AS lens,
         CASE WHEN rt.kind = 'finals' THEN 'gallery'
              ELSE 'incoming' END                            AS source,
         count(*)::int                                       AS count,
         count(*) FILTER (WHERE a.media_type = 'photo')::int  AS photos,
         count(*) FILTER (WHERE a.media_type = 'video')::int  AS videos,
         min(a.captured_at)                                  AS first_capture,
         max(a.captured_at)                                  AS last_capture,
         min(NULLIF(a.focal_length, 0))                      AS focal_min,
         max(NULLIF(a.focal_length, 0))                      AS focal_max,
         min(NULLIF(a.aperture, 0))                          AS aperture_min
    FROM assets a
    JOIN sessions s ON s.id = a.session_id
    JOIN roots rt   ON rt.id = s.root_id
   WHERE a.deleted_at IS NULL
     AND a.group_role IS DISTINCT FROM 'companion'
     AND a.device IS NOT NULL AND a.device <> ''
     AND rt.kind IN ('source', 'inbox', 'finals')
   GROUP BY 1, 2, 3`;

/** Folds one aggregate row into a running tally (mutates and returns `s`). */
function add(s: GearStats, r: Row): GearStats {
  s.count += r.count;
  s.photos += r.photos;
  s.videos += r.videos;
  // Date spans widen across every row folded in — a body's span is the union of
  // its lenses', a lens' span the union of the two sources'.
  if (r.first_capture && (!s.first_capture || r.first_capture < s.first_capture))
    s.first_capture = r.first_capture;
  if (r.last_capture && (!s.last_capture || r.last_capture > s.last_capture))
    s.last_capture = r.last_capture;
  return s;
}

const stats = (): GearStats => ({ ...EMPTY_STATS });

/** Widest of two optional bounds, ignoring the nulls (unrecorded EXIF). */
const lo = (a: number | null, b: number | null) =>
  a == null ? b : b == null ? a : Math.min(a, b);
const hi = (a: number | null, b: number | null) =>
  a == null ? b : b == null ? a : Math.max(a, b);

/** Busiest first, across BOTH sources, then by label so the order is stable. */
function byUse<T extends { incoming: GearStats; gallery: GearStats; label: string }>(
  a: T,
  b: T,
): number {
  const total = (x: T) => x.incoming.count + x.gallery.count;
  return total(b) - total(a) || a.label.localeCompare(b.label);
}

// A lens under construction: the merged tallies plus how many frames each raw
// spelling contributed, so the busiest one can name the card.
type LensAcc = GearLens & { spellings: Map<string, number> };

export async function listCameras(): Promise<GearCamera[]> {
  const rows = await many<Row>(GEAR_SQL);

  const cameras = new Map<string, GearCamera>();
  const lenses = new Map<string, Map<string, LensAcc>>();

  for (const r of rows) {
    let cam = cameras.get(r.device);
    if (!cam) {
      cam = {
        name: r.device,
        label: friendlyCameraName(r.device),
        incoming: stats(),
        gallery: stats(),
        lenses: [],
      };
      cameras.set(r.device, cam);
      lenses.set(r.device, new Map());
    }
    add(cam[r.source], r);

    // A frame with no lens tag still counts towards its body, but there is no
    // lens card to hang it on — the shelf says so instead of inventing one.
    if (!r.lens) continue;

    const shelf = lenses.get(r.device)!;
    const key = lensKey(r.lens);
    let lens = shelf.get(key);
    if (!lens) {
      lens = {
        key,
        label: "",
        names: [],
        focal_min: null,
        focal_max: null,
        aperture_min: null,
        incoming: stats(),
        gallery: stats(),
        spellings: new Map(),
      };
      shelf.set(key, lens);
    }
    add(lens[r.source], r);
    lens.spellings.set(r.lens, (lens.spellings.get(r.lens) ?? 0) + r.count);
    lens.focal_min = lo(lens.focal_min, r.focal_min);
    lens.focal_max = hi(lens.focal_max, r.focal_max);
    lens.aperture_min = lo(lens.aperture_min, r.aperture_min);
  }

  for (const [device, shelf] of lenses) {
    cameras.get(device)!.lenses = [...shelf.values()]
      .map(({ spellings, ...lens }) => {
        // Busiest spelling first — it names the card, and a tie falls back to
        // the alphabet so the label doesn't flip between requests.
        const names = [...spellings.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([name]) => name);
        return { ...lens, names, label: friendlyLensName(names[0]) };
      })
      .sort(byUse);
  }
  return [...cameras.values()].sort(byUse);
}
