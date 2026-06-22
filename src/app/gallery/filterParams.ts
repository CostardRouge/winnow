import { type Filters } from "./FilterPanel";

// URL ⇄ Filters serialization. The address bar mirrors the active filters so a
// view is shareable and survives a reload. We keep the URL in *UI units* (size
// in MB, booleans as "1") so links stay human-readable and round-trip cleanly
// with the FilterPanel inputs. The API query is a separate, byte-based encoding
// (see GalleryShell.toQuery) and intentionally not reused here.
//
// Param names mirror the Filters keys so the query string reads like the state.

const STR_ARRAYS = [
  "media_type",
  "ext",
  "derivative_status",
  "not_derivative_status",
  "device",
  "camera_model",
  "lens",
  "tags",
] as const;
const NUM_ARRAYS = ["year", "month", "day"] as const;
const NUMS = [
  "root_id",
  "session_id",
  "star_min",
  "iso_min",
  "iso_max",
  "focal_min",
  "focal_max",
  "aperture_min",
  "aperture_max",
  "size_min",
  "size_max",
] as const;
const STRS = ["date_from", "date_to", "q"] as const;
const BOOLS = ["has_gps", "show_ignored", "show_completed"] as const;

export function encodeFilters(f: Filters): URLSearchParams {
  const sp = new URLSearchParams();
  for (const k of STR_ARRAYS) if (f[k].length) sp.set(k, f[k].join(","));
  for (const k of NUM_ARRAYS) if (f[k].length) sp.set(k, f[k].join(","));
  for (const k of NUMS) {
    const v = f[k];
    if (v != null) sp.set(k, String(v));
  }
  for (const k of STRS) {
    const v = f[k];
    if (v) sp.set(k, v);
  }
  for (const k of BOOLS) if (f[k]) sp.set(k, "1");
  if (f.verdict) sp.set("verdict", f.verdict);
  if (f.group_kind) sp.set("group_kind", f.group_kind);
  if (f.bbox) sp.set("bbox", f.bbox.join(","));
  return sp;
}

export function decodeFilters(params: URLSearchParams): Filters {
  const f: Filters = {
    media_type: [],
    ext: [],
    derivative_status: [],
    not_derivative_status: [],
    device: [],
    camera_model: [],
    lens: [],
    tags: [],
    year: [],
    month: [],
    day: [],
  };
  const csv = (s: string | null) => (s ? s.split(",").filter(Boolean) : []);

  for (const k of STR_ARRAYS) f[k] = csv(params.get(k));
  for (const k of NUM_ARRAYS)
    f[k] = csv(params.get(k))
      .map(Number)
      .filter((n) => !Number.isNaN(n));
  for (const k of NUMS) {
    const v = params.get(k);
    if (v != null && v !== "" && !Number.isNaN(Number(v))) f[k] = Number(v);
  }
  for (const k of STRS) {
    const v = params.get(k);
    if (v) f[k] = v;
  }
  for (const k of BOOLS) if (params.get(k)) f[k] = true;

  const verdict = params.get("verdict");
  if (verdict === "pick" || verdict === "reject" || verdict === "unrated")
    f.verdict = verdict;

  const groupKind = params.get("group_kind");
  if (groupKind === "raw_jpeg" || groupKind === "live_photo")
    f.group_kind = groupKind;

  const bbox = csv(params.get("bbox")).map(Number);
  if (bbox.length === 4 && bbox.every((n) => !Number.isNaN(n)))
    f.bbox = [bbox[0], bbox[1], bbox[2], bbox[3]];

  return f;
}
