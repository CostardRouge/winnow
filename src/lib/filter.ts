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
    verdict: z.enum(["pick", "reject", "unrated"]).optional(),
    star_min: z.coerce.number().int().min(0).max(5).optional(),

    // Type / format
    media_type: csv, // photo | video (multi)
    ext: csv, // .arw, .jpg... (multi)
    // RAW+JPEG pairing: true → only paired assets, false → only standalone ones
    // (cf. lib/pairing.ts). The "RAW+JPEG" facet toggle maps to `paired=1`.
    paired: boolish,

    // Device / EXIF (multi)
    device: csv,
    camera_model: csv,
    lens: csv,

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

    // Tags (free-form): ANY inclusion / ANY exclusion
    tags: csv,
    not_tags: csv,

    // Free-text search over the file path (folder + filename). Whitespace splits
    // it into tokens, each matched as a case-insensitive substring (AND).
    q: z.string().trim().min(1).max(200).optional(),

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

  // Collapse RAW+JPEG pairs to one row: hide the companion, keep the displayed
  // primary. Opt-in (gallery/session grid) so exports and per-file triage still
  // see every file. NULL group_role (unpaired) is always kept.
  if (opts.collapseGroups) {
    conditions.push("a.group_role IS DISTINCT FROM 'companion'");
  }
  if (filter.device) inAny("a.device", filter.device);
  if (filter.camera_model) inAny("a.camera_model", filter.camera_model);
  if (filter.lens) inAny("a.lens", filter.lens);

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
    // Free-text path search: every whitespace-separated token must appear
    // somewhere in rel_path (folder + filename), case-insensitively. ANDed
    // tokens narrow the result; each ILIKE rides the rel_path trigram index
    // (migration 0010). Capped so a pathological query can't explode the SQL.
    const tokens = filter.q.split(/\s+/).filter(Boolean).slice(0, 10);
    for (const tok of tokens) {
      conditions.push(`a.rel_path ILIKE $${i++}`);
      params.push(`%${escapeLike(tok)}%`);
    }
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
    "device",
    "camera_model",
    "lens",
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
    "has_gps",
    "bbox",
    "q",
  ] as const;
  const raw: Record<string, string> = {};
  for (const k of keys) {
    const v = sp.get(k);
    if (v != null && v !== "") raw[k] = v;
  }
  return FilterSchema.parse(raw);
}
