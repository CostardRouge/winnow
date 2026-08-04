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
  "place_country",
  "place_region",
  "place_county",
  "place_city",
  "place_poi",
  "tags",
] as const;
const NUM_ARRAYS = ["year", "month", "day", "face_count", "person"] as const;
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
  "sharpness_min",
  "sharpness_max",
] as const;
const STRS = ["date_from", "date_to", "q"] as const;
// Truthy-only flags. `has_edit`/`is_edit` deliberately live OUTSIDE this list:
// they're tri-state (cf. below), and this list's decode tests the *string's*
// truthiness — `?has_edit=0` would come back as `true`.
const BOOLS = ["has_gps", "show_ignored", "has_text", "near_dup"] as const;

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
  // Tri-state: true ("only with faces") and false ("only without") both encode.
  if (f.has_faces != null) sp.set("has_faces", f.has_faces ? "1" : "0");
  // Same tri-state for burst piles: "only stacked" / "only standalone".
  if (f.stacked != null) sp.set("stacked", f.stacked ? "1" : "0");
  // Finals ↔ sources (cf. lib/reconcile.ts), tri-state on both directions:
  // "has an edit" / "not edited yet", and "linked to an original" / "no original
  // found". The `false` side is what surfaces the unpublished backlog and the
  // reconciliation misses. Old `?has_edit=1` deep links keep their meaning.
  if (f.has_edit != null) sp.set("has_edit", f.has_edit ? "1" : "0");
  if (f.is_edit != null) sp.set("is_edit", f.is_edit ? "1" : "0");
  if (f.verdict) sp.set("verdict", f.verdict);
  if (f.group_kind) sp.set("group_kind", f.group_kind);
  if (f.person_mode === "all") sp.set("person_mode", "all");
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
    place_country: [],
    place_region: [],
    place_county: [],
    place_city: [],
    place_poi: [],
    face_count: [],
    person: [],
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

  const hasFaces = params.get("has_faces");
  if (hasFaces === "1") f.has_faces = true;
  else if (hasFaces === "0") f.has_faces = false;

  const stacked = params.get("stacked");
  if (stacked === "1") f.stacked = true;
  else if (stacked === "0") f.stacked = false;

  const hasEdit = params.get("has_edit");
  if (hasEdit === "1") f.has_edit = true;
  else if (hasEdit === "0") f.has_edit = false;

  const isEdit = params.get("is_edit");
  if (isEdit === "1") f.is_edit = true;
  else if (isEdit === "0") f.is_edit = false;

  const verdict = params.get("verdict");
  if (verdict === "pick" || verdict === "reject" || verdict === "unrated")
    f.verdict = verdict;

  const groupKind = params.get("group_kind");
  if (groupKind === "raw_jpeg" || groupKind === "live_photo")
    f.group_kind = groupKind;

  // People combinator (cf. lib/filter.ts): only "all" is ever encoded ("any"
  // is the default and stays out of the URL).
  if (params.get("person_mode") === "all") f.person_mode = "all";

  const bbox = csv(params.get("bbox")).map(Number);
  if (bbox.length === 4 && bbox.every((n) => !Number.isNaN(n)))
    f.bbox = [bbox[0], bbox[1], bbox[2], bbox[3]];

  return f;
}
