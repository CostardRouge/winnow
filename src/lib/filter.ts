// SQL filter construction shared between the gallery, the session grid
// and the exports. Every query joins `assets a` LEFT JOIN `ratings r`.
//
// CUMULATIVE filters (combined with AND). Categorical dimensions accept
// multiple values (CSV -> IN/ANY); numeric/temporal dimensions
// accept min/max bounds. Everything relies on indexed columns (cf.
// migration 0003) - no on-the-fly computation.
import { z } from "zod";
import { kindsForRole } from "./roles";

// "a,b,c" | ["a","b"] | "a"  ->  ["a","b","c"]  (empty -> undefined)
const csv = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => {
    if (v == null) return undefined;
    const arr = Array.isArray(v) ? v : v.split(",");
    const out = arr.map((s) => s.trim()).filter(Boolean);
    return out.length ? out : undefined;
  });

// Bounding box "west,south,east,north" (four floats) -> {w,s,e,n}. Anything
// malformed (wrong arity, non-finite) collapses to undefined (no geo filter).
const bbox = z
  .union([z.string(), z.array(z.union([z.string(), z.number()]))])
  .optional()
  .transform((v) => {
    if (v == null) return undefined;
    const arr = Array.isArray(v) ? v : v.split(",");
    const nums = arr.map((s) => Number(String(s).trim()));
    if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n)))
      return undefined;
    const [w, s, e, n] = nums;
    return { w, s, e, n };
  });

// Tri-state boolean from a query string: "1"/"true"/"yes" → true,
// "0"/"false"/"no" → false, anything else → undefined. Unlike z.coerce.boolean
// (where the string "0" is truthy), this lets a filter mean "only false".
const boolish = z
  .union([z.string(), z.boolean()])
  .optional()
  .transform((v) => {
    if (v == null) return undefined;
    if (typeof v === "boolean") return v;
    const s = v.trim().toLowerCase();
    if (s === "1" || s === "true" || s === "yes") return true;
    if (s === "0" || s === "false" || s === "no") return false;
    return undefined;
  });

// Like intList, but also tolerates a JSON array of numbers (export jobs persist
// `filter.ids` as numbers, not strings).
const intList = z
  .union([z.string(), z.array(z.union([z.string(), z.number()]))])
  .optional()
  .transform((v) => {
    if (v == null) return undefined;
    const arr = Array.isArray(v) ? v : v.split(",");
    const out = arr
      .map((s) => Number.parseInt(String(s).trim(), 10))
      .filter((n) => Number.isFinite(n));
    return out.length ? out : undefined;
  });

// Hamming-distance ceiling for the "has a near-duplicate" filter. Deliberately
// tighter than the /similar strip's default (16 = "probably unrelated"
// boundary): a FILTER wants precision, so ~10 ("very close" on the dHash scale)
// keeps false positives down while still catching bursts / re-exports / resizes.
const NEAR_DUP_MAX_DISTANCE = 10;

export const FilterSchema = z
  .object({
    // Explicit selection (per-asset / bulk actions, e.g. export a selection).
    ids: intList,
    // Scope
    session_id: z.coerce.number().int().optional(),
    root_id: z.coerce.number().int().optional(),
    // Scope by folder role (Incoming/Final) - mapped to Postgres kinds.
    kind: z.enum(["incoming", "final"]).optional(),
    processing_state: z
      .enum(["ignored", "unprocessed", "triaged", "exported"])
      .optional(),
    // Derivative lifecycle (multi): pending | processing | ready | error |
    // skipped. Drives the Pipeline triage pages (Pending / Analyzed).
    // `not_derivative_status` is the inverse (NOT IN): the gallery's
    // "Exclude" filter mode hides assets in the listed states.
    derivative_status: csv,
    not_derivative_status: csv,

    // Culling
    verdict: z.enum(["pick", "reject", "skip", "unrated"]).optional(),
    star_min: z.coerce.number().int().min(0).max(5).optional(),

    // Type / format
    media_type: csv, // photo | video (multi)
    ext: csv, // .arw, .jpg... (multi)
    // Pairing (cf. lib/pairing.ts): true → only paired assets, false → only
    // standalone ones. `group_kind` narrows to one kind of pair — the "Live
    // Photos" filter toggle maps to `group_kind=live_photo`.
    paired: boolish,
    group_kind: z.enum(["raw_jpeg", "live_photo"]).optional(),
    // Burst/bracket stacks (cf. lib/bursts.ts). `stacked` → only frames that are
    // in a pile (true) / only standalone frames (false). `burst_id` drills into
    // ONE pile: it returns every frame of that stack AND suppresses the
    // collapse-to-cover, so the grid can expand the pile in place.
    stacked: boolish,
    burst_id: z.coerce.number().int().optional(),
    // Finals → sources reconciliation (cf. lib/reconcile.ts). `is_edit` → finals
    // linked back to a source (true) / not an edit (false). `has_edit` → sources
    // that have at least one linked edit (true) / none (false).
    is_edit: boolish,
    has_edit: boolish,

    // Device / EXIF (multi)
    device: csv,
    camera_model: csv,
    lens: csv,

    // Reverse-geocoded place (cf. lib/geocode.ts), all multi-value. Filter by
    // where a photo was taken using the denormalized name columns on `assets`.
    place_country: csv,
    place_region: csv,
    place_county: csv,
    place_city: csv,
    place_poi: csv,
    // True → only assets with a resolved place; false → only those without.
    has_place: boolish,

    // ML analysis (faces + OCR, cf. lib/ml.ts). `face_count` matches exact
    // detected-face counts (multi, e.g. "2,3"); `has_faces` is the boolean
    // shortcut (true → at least one face; false → none detected/analyzed yet).
    // `has_text` keys on the OCR result the same way.
    face_count: intList,
    has_faces: boolish,
    has_text: boolish,
    // Perceptual near-duplicates (cf. lib/ml.ts, GET /api/assets/:id/similar):
    // true → only frames that have a look-alike within the same session; false →
    // only the loners (unanalyzed included). A gallery-wide companion to the
    // byte-exact content_hash dedup and the per-asset "Similar" strip.
    near_dup: boolish,

    // Calendar (multi-value) + date range
    year: intList,
    month: intList, // 1-12
    day: intList, // 1-31
    date_from: z.string().optional(), // YYYY-MM-DD
    date_to: z.string().optional(),

    // Numeric ranges
    iso_min: z.coerce.number().optional(),
    iso_max: z.coerce.number().optional(),
    aperture_min: z.coerce.number().optional(),
    aperture_max: z.coerce.number().optional(),
    focal_min: z.coerce.number().optional(),
    focal_max: z.coerce.number().optional(),
    size_min: z.coerce.number().optional(), // bytes
    size_max: z.coerce.number().optional(),
    // Sharpness (variance of the Laplacian, cf. lib/ml.ts): low = blurry.
    // `sharpness_max` alone is the "surface the soft/blurry shots" filter.
    sharpness_min: z.coerce.number().optional(),
    sharpness_max: z.coerce.number().optional(),

    // Tags (free-form): ANY inclusion / ANY exclusion
    tags: csv,
    not_tags: csv,

    // Free-text search over the file path (folder + filename). Whitespace splits
    // it into tokens, each matched as a case-insensitive substring (AND).
    q: z.string().trim().min(1).max(200).optional(),

    // Scope to a directory subtree: keep assets whose absolute path lives under
    // this folder (prefix match on abs_path). Drives the Pipeline folder tree —
    // picking a node scopes the grid to everything beneath it.
    under: z.string().min(1).max(4096).optional(),

    // Misc
    has_gps: z.coerce.boolean().optional(),
    // Map zone: bounding box "w,s,e,n" (filters on the materialized gps_lat/lon).
    bbox,
  })
  .strip();

export type AssetFilter = z.infer<typeof FilterSchema>;

// Escapes the LIKE/ILIKE wildcards so a user's literal `%`/`_` (and the `\`
// escape char itself) match themselves rather than acting as patterns.
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// How a query treats soft-deleted assets:
//   "exclude" (default) → live library: deleted_at IS NULL (hides trash + purged).
//   "trash"             → the recycle bin: deleted but not yet purged.
export type DeletedScope = "exclude" | "trash";

export function buildFilter(
  filter: AssetFilter,
  startIdx = 1,
  opts: { deleted?: DeletedScope; collapseGroups?: boolean } = {},
): { conditions: string[]; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let i = startIdx;

  // Soft-deleted assets are hidden everywhere (gallery, sessions, facets,
  // exports). No param: constant predicates the planner serves from the
  // assets_not_deleted_idx / assets_trash_idx partial indexes. The Trash view
  // and the purge worker flip this to "trash" to operate on the recycle bin.
  if ((opts.deleted ?? "exclude") === "trash") {
    conditions.push("a.deleted_at IS NOT NULL AND a.purged_at IS NULL");
  } else {
    conditions.push("a.deleted_at IS NULL");
  }

  const eq = (col: string, val: unknown) => {
    conditions.push(`${col} = $${i++}`);
    params.push(val);
  };
  const inAny = (col: string, vals: unknown[]) => {
    conditions.push(`${col} = ANY($${i++})`);
    params.push(vals);
  };
  const gte = (col: string, val: unknown) => {
    conditions.push(`${col} >= $${i++}`);
    params.push(val);
  };
  const lte = (col: string, val: unknown) => {
    conditions.push(`${col} <= $${i++}`);
    params.push(val);
  };

  if (filter.ids) inAny("a.id", filter.ids);
  if (filter.session_id != null) eq("a.session_id", filter.session_id);
  if (filter.root_id != null) {
    conditions.push(
      `a.session_id IN (SELECT id FROM sessions WHERE root_id = $${i++})`,
    );
    params.push(filter.root_id);
  }
  if (filter.kind != null) {
    // Scope by role via sessions->roots (subquery, like root_id: no
    // additional JOIN to propagate to callers).
    conditions.push(
      `a.session_id IN (
         SELECT s.id FROM sessions s JOIN roots rt ON rt.id = s.root_id
         WHERE rt.kind = ANY($${i++}))`,
    );
    params.push(kindsForRole(filter.kind));
  }
  if (filter.processing_state != null)
    eq("a.processing_state", filter.processing_state);
  if (filter.derivative_status)
    inAny("a.derivative_status", filter.derivative_status);
  if (filter.not_derivative_status) {
    // Inverse of the above: keep assets whose status is none of the listed
    // values (<> ALL == NOT IN). derivative_status is never NULL, so no
    // COALESCE is needed.
    conditions.push(`a.derivative_status <> ALL($${i++})`);
    params.push(filter.not_derivative_status);
  }

  if (filter.verdict != null) {
    if (filter.verdict === "unrated") {
      conditions.push(`COALESCE(r.verdict, 'unrated') = 'unrated'`);
    } else {
      eq("r.verdict", filter.verdict);
    }
  }
  if (filter.star_min != null) {
    conditions.push(`COALESCE(r.star, 0) >= $${i++}`);
    params.push(filter.star_min);
  }

  if (filter.media_type) inAny("a.media_type", filter.media_type);
  if (filter.ext) inAny("a.ext", filter.ext);
  if (filter.paired === true) conditions.push("a.group_id IS NOT NULL");
  else if (filter.paired === false) conditions.push("a.group_id IS NULL");
  if (filter.group_kind != null) {
    // Restrict to assets belonging to a group of this kind (live_photo /
    // raw_jpeg). Subquery on asset_groups so callers need no extra JOIN.
    conditions.push(
      `a.group_id IN (SELECT id FROM asset_groups WHERE kind = $${i++})`,
    );
    params.push(filter.group_kind);
  }

  // Burst/bracket stacks (cf. lib/bursts.ts). `burst_id` drills into one pile;
  // `stacked` keys on membership. Both ride the assets_burst_idx index.
  if (filter.burst_id != null) eq("a.burst_id", filter.burst_id);
  if (filter.stacked === true) conditions.push("a.burst_id IS NOT NULL");
  else if (filter.stacked === false) conditions.push("a.burst_id IS NULL");

  // Finals → sources reconciliation. `is_edit` keys on the link column directly;
  // `has_edit` on the existence of an edit pointing back at this asset (the
  // reverse fan-out, served by assets_original_idx). No params: constant
  // predicates.
  if (filter.is_edit === true) conditions.push("a.original_asset_id IS NOT NULL");
  else if (filter.is_edit === false)
    conditions.push("a.original_asset_id IS NULL");
  if (filter.has_edit === true) {
    conditions.push(
      `EXISTS (SELECT 1 FROM assets e
                WHERE e.original_asset_id = a.id AND e.deleted_at IS NULL)`,
    );
  } else if (filter.has_edit === false) {
    conditions.push(
      `NOT EXISTS (SELECT 1 FROM assets e
                    WHERE e.original_asset_id = a.id AND e.deleted_at IS NULL)`,
    );
  }

  // Collapse RAW+JPEG pairs to one row: hide the companion, keep the displayed
  // primary. Opt-in (gallery/session grid) so exports and per-file triage still
  // see every file. NULL group_role (unpaired) is always kept.
  if (opts.collapseGroups) {
    conditions.push("a.group_role IS DISTINCT FROM 'companion'");
    // Collapse burst/bracket stacks to their cover frame, so a pile shows as one
    // tile in the grid. Orthogonal to the pair collapse above (a stack is built
    // over logical media, so a cover can itself be a pair primary). Suppressed
    // when drilling into a specific pile (burst_id set) so that request returns
    // every frame. Non-stacked assets (burst_id NULL) are always kept.
    //
    // The representative is the stored cover when it's still live, else the
    // pile's first live frame — so trashing the cover surfaces the next frame
    // instead of hiding the whole pile. Bounded per-pile subquery on
    // assets_burst_idx (piles are small).
    if (filter.burst_id == null) {
      conditions.push(
        `(a.burst_id IS NULL
          OR a.id = (
            SELECT bm.id FROM assets bm
            WHERE bm.burst_id = a.burst_id AND bm.deleted_at IS NULL
            ORDER BY bm.id = (SELECT b.cover_asset_id FROM bursts b
                              WHERE b.id = a.burst_id) DESC,
                     bm.burst_seq ASC, bm.id ASC
            LIMIT 1
          ))`,
      );
    }
  }
  if (filter.device) inAny("a.device", filter.device);
  if (filter.camera_model) inAny("a.camera_model", filter.camera_model);
  if (filter.lens) inAny("a.lens", filter.lens);

  // Reverse-geocoded place (cf. lib/geocode.ts): categorical, on the indexed
  // denormalized columns — no JOIN to `places` needed.
  if (filter.place_country) inAny("a.place_country", filter.place_country);
  if (filter.place_region) inAny("a.place_region", filter.place_region);
  if (filter.place_county) inAny("a.place_county", filter.place_county);
  if (filter.place_city) inAny("a.place_city", filter.place_city);
  if (filter.place_poi) inAny("a.place_poi", filter.place_poi);
  if (filter.has_place === true) conditions.push("a.place_id IS NOT NULL");
  else if (filter.has_place === false) conditions.push("a.place_id IS NULL");

  // ML analysis (cf. lib/ml.ts), on the indexed denormalized columns. NULL
  // face_count = not analyzed yet, so "no faces" includes the unanalyzed —
  // mirroring has_place=false (which also lumps pending in with "without").
  if (filter.face_count) inAny("a.face_count", filter.face_count);
  if (filter.has_faces === true) conditions.push("a.face_count >= 1");
  else if (filter.has_faces === false)
    conditions.push("COALESCE(a.face_count, 0) = 0");
  if (filter.has_text === true) conditions.push("a.ocr_text IS NOT NULL");
  else if (filter.has_text === false) conditions.push("a.ocr_text IS NULL");

  if (filter.year) inAny("a.capture_year", filter.year);
  if (filter.month) inAny("a.capture_month", filter.month);
  if (filter.day) inAny("a.capture_day", filter.day);
  if (filter.date_from) gte("a.capture_date", filter.date_from);
  if (filter.date_to) lte("a.capture_date", filter.date_to);

  if (filter.iso_min != null) gte("a.iso", filter.iso_min);
  if (filter.iso_max != null) lte("a.iso", filter.iso_max);
  if (filter.aperture_min != null) gte("a.aperture", filter.aperture_min);
  if (filter.aperture_max != null) lte("a.aperture", filter.aperture_max);
  if (filter.focal_min != null) gte("a.focal_length", filter.focal_min);
  if (filter.focal_max != null) lte("a.focal_length", filter.focal_max);
  if (filter.size_min != null) gte("a.file_size", filter.size_min);
  if (filter.size_max != null) lte("a.file_size", filter.size_max);
  if (filter.sharpness_min != null) gte("a.sharpness", filter.sharpness_min);
  if (filter.sharpness_max != null) lte("a.sharpness", filter.sharpness_max);

  // Perceptual near-duplicate: a frame has one when another LIVE frame IN THE
  // SAME SESSION lands within NEAR_DUP_MAX_DISTANCE Hamming bits of its dHash —
  // bit_count over the XOR of the two 64-bit phashes, the same measure the
  // /similar route ranks by (cf. lib/ml.ts). Scoped to the session (where bursts
  // and re-exports land together) so the correlated self-join stays bounded; an
  // unscoped, library-wide near match would be O(N^2). `false` keeps the loners
  // AND the not-yet-analyzed (phash NULL → the inner is empty → NOT EXISTS true),
  // mirroring how has_faces=false lumps in the unanalyzed.
  if (filter.near_dup === true || filter.near_dup === false) {
    const exists = `EXISTS (
      SELECT 1 FROM assets nd
       WHERE nd.session_id = a.session_id
         AND nd.id <> a.id
         AND nd.deleted_at IS NULL
         AND nd.phash IS NOT NULL
         AND a.phash IS NOT NULL
         AND bit_count((a.phash # nd.phash)::bit(64)) <= $${i++})`;
    params.push(NEAR_DUP_MAX_DISTANCE);
    conditions.push(filter.near_dup ? exists : `NOT ${exists}`);
  }

  if (filter.tags) {
    conditions.push(
      `EXISTS (SELECT 1 FROM asset_tags at JOIN tags t ON t.id = at.tag_id
               WHERE at.asset_id = a.id AND t.name = ANY($${i++}))`,
    );
    params.push(filter.tags);
  }
  if (filter.not_tags) {
    conditions.push(
      `NOT EXISTS (SELECT 1 FROM asset_tags at JOIN tags t ON t.id = at.tag_id
                   WHERE at.asset_id = a.id AND t.name = ANY($${i++}))`,
    );
    params.push(filter.not_tags);
  }

  if (filter.q) {
    // Free-text search: every whitespace-separated token must appear in the
    // file path (folder + filename) OR in the text the OCR read in the image,
    // case-insensitively. ANDed tokens narrow the result; each ILIKE rides a
    // trigram index (rel_path: migration 0010, ocr_text: migration 0021).
    // Capped so a pathological query can't explode the SQL.
    const tokens = filter.q.split(/\s+/).filter(Boolean).slice(0, 10);
    for (const tok of tokens) {
      conditions.push(`(a.rel_path ILIKE $${i} OR a.ocr_text ILIKE $${i})`);
      params.push(`%${escapeLike(tok)}%`);
      i++;
    }
  }

  // Directory-subtree scope: everything under this folder. The trailing "/%"
  // makes it a strict descendant match (the folder's own path never matches its
  // files, only paths beneath it). LIKE wildcards in the user path are escaped.
  if (filter.under) {
    const prefix = filter.under.replace(/\/+$/, "");
    conditions.push(`a.abs_path LIKE $${i++} ESCAPE '\\'`);
    params.push(`${escapeLike(prefix)}/%`);
  }

  if (filter.has_gps) conditions.push(`a.gps IS NOT NULL`);

  if (filter.bbox) {
    const { w, s, e, n } = filter.bbox;
    // Always require a geotag; then a latitude band + a longitude band on the
    // materialized columns (indexed). South/north tolerated in any order.
    conditions.push(`a.gps_lat IS NOT NULL`);
    conditions.push(`a.gps_lat >= $${i++}`);
    params.push(Math.min(s, n));
    conditions.push(`a.gps_lat <= $${i++}`);
    params.push(Math.max(s, n));
    if (w <= e) {
      conditions.push(`a.gps_lon >= $${i++}`);
      params.push(w);
      conditions.push(`a.gps_lon <= $${i++}`);
      params.push(e);
    } else {
      // Box straddling the antimeridian (west > east): longitude wraps.
      conditions.push(`(a.gps_lon >= $${i} OR a.gps_lon <= $${i + 1})`);
      params.push(w, e);
      i += 2;
    }
  }

  return { conditions, params };
}

// Parses the filters from a URL's query params (all dimensions).
export function filterFromSearchParams(sp: URLSearchParams): AssetFilter {
  const keys = [
    "ids",
    "session_id",
    "root_id",
    "kind",
    "processing_state",
    "derivative_status",
    "not_derivative_status",
    "tags",
    "not_tags",
    "verdict",
    "star_min",
    "media_type",
    "ext",
    "paired",
    "group_kind",
    "stacked",
    "burst_id",
    "is_edit",
    "has_edit",
    "device",
    "camera_model",
    "lens",
    "place_country",
    "place_region",
    "place_county",
    "place_city",
    "place_poi",
    "has_place",
    "face_count",
    "has_faces",
    "has_text",
    "near_dup",
    "year",
    "month",
    "day",
    "date_from",
    "date_to",
    "iso_min",
    "iso_max",
    "aperture_min",
    "aperture_max",
    "focal_min",
    "focal_max",
    "size_min",
    "size_max",
    "sharpness_min",
    "sharpness_max",
    "has_gps",
    "bbox",
    "q",
    "under",
  ] as const;
  const raw: Record<string, string> = {};
  for (const k of keys) {
    const v = sp.get(k);
    if (v != null && v !== "") raw[k] = v;
  }
  return FilterSchema.parse(raw);
}
