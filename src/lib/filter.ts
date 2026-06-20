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
    derivative_status: csv,

    // Culling
    verdict: z.enum(["pick", "reject", "unrated"]).optional(),
    star_min: z.coerce.number().int().min(0).max(5).optional(),

    // Type / format
    media_type: csv, // photo | video (multi)
    ext: csv, // .arw, .jpg... (multi)

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

    // Misc
    has_gps: z.coerce.boolean().optional(),
    // Map zone: bounding box "w,s,e,n" (filters on the materialized gps_lat/lon).
    bbox,
  })
  .strip();

export type AssetFilter = z.infer<typeof FilterSchema>;

export function buildFilter(
  filter: AssetFilter,
  startIdx = 1,
): { conditions: string[]; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let i = startIdx;

  // Soft-deleted assets are hidden everywhere (gallery, sessions, facets,
  // exports). No param: a constant predicate the planner uses with the
  // assets_not_deleted_idx partial index.
  conditions.push("a.deleted_at IS NULL");

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
    "tags",
    "not_tags",
    "verdict",
    "star_min",
    "media_type",
    "ext",
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
  ] as const;
  const raw: Record<string, string> = {};
  for (const k of keys) {
    const v = sp.get(k);
    if (v != null && v !== "") raw[k] = v;
  }
  return FilterSchema.parse(raw);
}
