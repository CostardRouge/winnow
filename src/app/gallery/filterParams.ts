import { MB, type Filters } from "./FilterPanel";

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
  "device_source",
  "shot_by",
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
const BOOLS = ["show_ignored", "has_text", "near_dup", "favourite"] as const;

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
  if (f.geo_state) sp.set("geo_state", f.geo_state);
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
    device_source: [],
    shot_by: [],
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

  // Position (cf. lib/filter.ts). The old `has_gps=1` checkbox is gone; a
  // bookmarked link that still carries it means the same as "placed".
  const geoState = params.get("geo_state");
  if (geoState === "placed" || geoState === "todo" || geoState === "exempt")
    f.geo_state = geoState;
  else if (params.get("has_gps")) f.geo_state = "placed";

  const bbox = csv(params.get("bbox")).map(Number);
  if (bbox.length === 4 && bbox.every((n) => !Number.isNaN(n)))
    f.bbox = [bbox[0], bbox[1], bbox[2], bbox[3]];

  return f;
}

// The API encoding of the filters (`/api/assets`, `/api/sessions/:id/assets`,
// the map and calendar routes): bytes for Size, `true`/`false` for the flags.
// Shared by GalleryShell and the session page so both send the same query for
// the same panel state — a second copy is how the two would drift.
// `scope` is the gallery's folder role (`kind=`), absent on the session page.
export function filterQuery(
  f: Filters,
  scope?: "incoming" | "final",
  cursor?: string | null,
  opts?: { skipBbox?: boolean },
): string {
  const sp = new URLSearchParams();
  const arr = (k: string, a: (string | number)[]) =>
    a.length && sp.set(k, a.join(","));
  if (f.q) sp.set("q", f.q);
  arr("media_type", f.media_type);
  arr("ext", f.ext);
  arr("derivative_status", f.derivative_status);
  arr("not_derivative_status", f.not_derivative_status);
  arr("device", f.device);
  arr("device_source", f.device_source);
  arr("shot_by", f.shot_by);
  arr("camera_model", f.camera_model);
  arr("lens", f.lens);
  arr("place_country", f.place_country);
  arr("place_region", f.place_region);
  arr("place_county", f.place_county);
  arr("place_city", f.place_city);
  arr("place_poi", f.place_poi);
  arr("tags", f.tags);
  arr("year", f.year);
  arr("month", f.month);
  arr("day", f.day);
  if (scope) sp.set("kind", scope);
  if (f.root_id != null) sp.set("root_id", String(f.root_id));
  if (f.session_id != null) sp.set("session_id", String(f.session_id));
  if (f.date_from) sp.set("date_from", f.date_from);
  if (f.date_to) sp.set("date_to", f.date_to);
  if (f.verdict) sp.set("verdict", f.verdict);
  if (f.star_min) sp.set("star_min", String(f.star_min));
  if (f.favourite) sp.set("favourite", "true");
  for (const k of [
    "iso_min", "iso_max", "focal_min", "focal_max", "aperture_min", "aperture_max",
    "sharpness_min", "sharpness_max",
  ] as const) {
    if (f[k] != null) sp.set(k, String(f[k]));
  }
  if (f.size_min != null) sp.set("size_min", String(Math.round(f.size_min * MB)));
  if (f.size_max != null) sp.set("size_max", String(Math.round(f.size_max * MB)));
  if (f.geo_state) sp.set("geo_state", f.geo_state);
  if (f.group_kind) sp.set("group_kind", f.group_kind);
  // Finals ↔ sources (cf. lib/reconcile.ts) — tri-state, like has_faces/stacked:
  // `false` asks for the complement (not edited yet / no original found).
  if (f.has_edit != null) sp.set("has_edit", f.has_edit ? "true" : "false");
  if (f.is_edit != null) sp.set("is_edit", f.is_edit ? "true" : "false");
  // ML analysis (faces + OCR + people, cf. lib/ml.ts, lib/people.ts). The
  // "together" combinator only means something with two or more people picked.
  arr("face_count", f.face_count);
  arr("person", f.person);
  if (f.person_mode === "all" && f.person.length > 1)
    sp.set("person_mode", "all");
  if (f.has_faces != null) sp.set("has_faces", f.has_faces ? "true" : "false");
  if (f.has_text) sp.set("has_text", "true");
  if (f.near_dup) sp.set("near_dup", "true");
  // Burst/bracket piles (cf. lib/bursts.ts) — tri-state, like has_faces.
  if (f.stacked != null) sp.set("stacked", f.stacked ? "true" : "false");
  if (f.burst_kind) sp.set("burst_kind", f.burst_kind);
  // Session-grid status toggle (ignored sessions are hidden by default).
  if (f.show_ignored) sp.set("show_ignored", "true");
  if (f.bbox && !opts?.skipBbox) sp.set("bbox", f.bbox.join(","));
  if (cursor) sp.set("cursor", cursor);
  return sp.toString();
}

// How many filter dimensions are narrowing the library right now. Feeds the
// toolbar's "N filters" pill so a reduced view is never mistaken for the whole
// library. Each dimension counts once however many values it holds ("3" should
// read as "three panel sections touched"), and min/max pairs count as one.
// `show_ignored` widens the Sessions grid rather than narrowing it — excluded.
const FILTER_ARRAY_KEYS = [
  "media_type", "ext", "derivative_status", "not_derivative_status",
  "device", "device_source", "shot_by", "camera_model", "lens",
  "place_country", "place_region", "place_county", "place_city", "place_poi",
  "person", "tags", "year", "month", "day",
] as const;

export function countActiveFilters(f: Filters): number {
  let n = 0;
  for (const k of FILTER_ARRAY_KEYS) if (f[k].length) n++;
  if (f.q) n++;
  if (f.root_id != null) n++;
  if (f.session_id != null) n++;
  if (f.date_from || f.date_to) n++;
  if (f.verdict) n++;
  if (f.star_min) n++;
  if (f.favourite) n++;
  if (f.iso_min != null || f.iso_max != null) n++;
  if (f.focal_min != null || f.focal_max != null) n++;
  if (f.aperture_min != null || f.aperture_max != null) n++;
  if (f.size_min != null || f.size_max != null) n++;
  if (f.sharpness_min != null || f.sharpness_max != null) n++;
  if (f.geo_state) n++;
  if (f.group_kind) n++;
  if (f.has_edit != null) n++;
  if (f.is_edit != null) n++;
  if (f.near_dup) n++;
  if (f.stacked != null) n++;
  if (f.burst_kind) n++;
  if (f.bbox) n++;
  return n;
}
