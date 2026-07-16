// Types of the Postgres rows (mirror of the §5 schema).

export type Root = {
  id: number;
  path: string;
  // 'inbox' is internal (drop zone consumed by the import); 'source' and
  // 'finals' carry the Incoming/Final role (cf. lib/roles.ts); 'export' is a
  // volume tracked for visibility but never walked (cf. lib/volumes.ts).
  kind: "source" | "finals" | "inbox" | "export";
  watch: boolean;
  added_at: string;
};

export type Session = {
  id: number;
  root_id: number;
  name: string;
  source_path: string;
  device_hint: string | null;
  captured_at_min: string | null;
  captured_at_max: string | null;
  asset_count: number;
  indexed_at: string | null;
  // The lone manual flag: "skip this whole session". Cascades the assets to
  // processing_state='ignored'. Everything else about a session's lifecycle
  // ("to sort" / "done" / "empty") is COMPUTED from verdict coverage, never
  // hand-set (cf. SessionStatus / api/sessions).
  ignored: boolean;
};

// Computed session lifecycle, derived from the verdict coverage of its live
// (non-deleted) media — never stored. `empty` has no media to sort; `to_sort`
// still has unrated media; `done` means every media has a verdict (pick /
// reject / skip). Orthogonal to the manual `ignored` flag.
export type SessionStatus = "empty" | "to_sort" | "done";

export type DerivativeStatus =
  | "pending"
  | "processing"
  | "ready"
  | "error"
  | "skipped";

export type ProcessingState =
  | "ignored"
  | "unprocessed"
  | "triaged"
  | "exported";

// A media's culling decision. `unrated` is the only "not yet decided" state;
// `pick`, `reject` and `skip` are all deliberate verdicts that count toward a
// session being "done". `skip` = reviewed but neither kept nor culled.
export type Verdict = "pick" | "reject" | "skip" | "unrated";

export type Asset = {
  id: number;
  session_id: number;
  abs_path: string;
  rel_path: string;
  filename: string;
  ext: string;
  media_type: "photo" | "video";
  device: string | null;
  file_size: number | null;
  file_mtime: string | null;
  content_hash: string | null;
  captured_at: string | null;
  camera_model: string | null;
  lens: string | null;
  iso: number | null;
  shutter: string | null;
  aperture: number | null;
  focal_length: number | null;
  gps: { lat: number; lon: number } | null;
  width: number | null;
  height: number | null;
  duration_s: number | null;
  // iPhone Live Photo link: Apple's Content Identifier, written on both the
  // still and its companion .mov. Used to tie the pair (cf. lib/pairing.ts).
  content_id: string | null;
  derivative_status: DerivativeStatus;
  derivative_error: string | null;
  processing_state: ProcessingState;
  thumb_key: string | null;
  proxy_key: string | null;
  // Soft delete: non-null = hidden from the library (original untouched). This
  // is the recycle bin — recoverable until purged.
  deleted_at: string | null;
  // File integrity (cf. lib/integrity.ts): non-null = the ORIGINAL is gone from
  // disk (confirmed by a per-file stat). Normally auto-trashed in the same
  // statement (deleted_at = missing_at); cleared automatically if the file
  // reappears. Triage lives in /pipeline/failures ("Missing files").
  missing_at: string | null;
  // Purge: non-null = the original (and its derivatives) were physically removed
  // to reclaim space. The row is kept for audit/lineage. `purge_error` holds the
  // last failure (e.g. a read-only mount) when a purge couldn't free the bytes.
  purged_at: string | null;
  purge_error: string | null;
  // Media pairing (cf. lib/pairing.ts). `group_id` ties a pair together;
  // `group_role` says which side this file is. The `primary` is shown by default
  // (RAW+JPEG → the direct file; Live Photo → the still); the `companion` is the
  // reachable other half (the RAW "source brute", or the Live Photo .mov motion).
  // Both null when the file is not paired.
  group_id: number | null;
  group_role: "primary" | "companion" | null;
  // Burst/bracket stack (cf. lib/bursts.ts). `burst_id` ties N distinct frames
  // shot in one quick run into a collapsible pile; `burst_seq` is this frame's
  // 1-based order within it. Orthogonal to the pairing above — a frame can be
  // both a RAW+JPEG pair and a stack member. Both null when not stacked.
  burst_id: number | null;
  burst_seq: number | null;
  // Finals → sources reconciliation (cf. lib/reconcile.ts). On an edited "final",
  // `original_asset_id` points at the source capture it was derived from; NULL on
  // sources and on unmatched finals. `edit_match` records how the link was made:
  // 'name_date' (basename + capture time), 'name' (basename only), 'manual'.
  original_asset_id: number | null;
  edit_match: string | null;
  // Reverse-geocoded place (cf. lib/geocode.ts). `place_id` links to the shared
  // per-cell `places` cache; the name columns are denormalized here for fast
  // facet/filter (country / région / département / city), and `place_poi` holds
  // the per-asset tourist/landmark name resolved at the exact coordinate.
  // `geocode_status` mirrors derivative_status through the resolve lifecycle.
  place_id: number | null;
  geocode_status: "pending" | "processing" | "ready" | "error" | "skipped";
  geocode_error: string | null;
  place_country: string | null;
  place_region: string | null;
  place_county: string | null;
  place_city: string | null;
  place_poi: string | null;
  // ML analysis (faces + OCR, cf. lib/ml.ts). `face_count` is NULL until the
  // asset is analyzed (0 = analyzed, none found); `ocr_text` carries the text
  // read in the image (newline-joined fragments, searched by the gallery's q=).
  // `ml_status` mirrors derivative_status through the analyze lifecycle.
  ml_status: "pending" | "processing" | "ready" | "error" | "skipped";
  ml_error: string | null;
  face_count: number | null;
  ocr_text: string | null;
  // Local quality/similarity metrics (cf. lib/ml.ts): variance-of-Laplacian
  // focus score (low = blurry) + 64-bit perceptual dHash (pg BIGINT → string).
  sharpness: number | null;
  phash: string | null;
  created_at: string;
  updated_at: string;
};

// One face detected in an asset (cf. lib/ml.ts). The bounding box is in pixels
// of the ANALYZED derivative (img_width/img_height carry its dimensions, so the
// box scales to any rendition). `embedding` keeps the recognition vector for a
// future person clustering — no re-inference needed.
export type AssetFace = {
  id: number;
  asset_id: number;
  score: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  img_width: number | null;
  img_height: number | null;
  embedding: number[] | null;
  created_at: string;
};

// A reverse-geocoded location (cf. lib/geocode.ts), cached once per coordinate
// cell and shared by every asset whose GPS falls in it.
export type Place = {
  id: number;
  cell_lat: number;
  cell_lon: number;
  precision_m: number;
  country: string | null;
  country_code: string | null;
  region: string | null;
  county: string | null;
  city: string | null;
  display_name: string | null;
  provider: string;
  raw: unknown;
  fetched_at: string;
  created_at: string;
};

// A burst/bracket stack (cf. lib/bursts.ts): N distinct frames captured in one
// quick run (same device, small temporal gap) grouped so the culling grid can
// collapse the pile to its `cover_asset_id` and cull it as a unit. Unlike an
// `asset_groups` pair, the members are separate shots and keep per-frame ratings.
export type Burst = {
  id: number;
  session_id: number;
  device: string | null;
  started_at: string | null;
  ended_at: string | null;
  cover_asset_id: number | null;
  member_count: number;
  created_at: string;
};

// A media group: the link between the two files of one capture. `raw_jpeg` ties
// a RAW "source" to its direct JPEG/HEIF companion; `live_photo` ties an iPhone
// still to its companion .mov motion. One row per logical pair (cf. lib/pairing.ts).
export type AssetGroup = {
  id: number;
  session_id: number;
  kind: "raw_jpeg" | "live_photo";
  created_at: string;
};

// A video sidecar (cf. lib/sidecars.ts): the small metadata/thumbnail/telemetry
// companion a camera writes next to a clip — Sony NRT metadata (C0001M01.XML),
// a per-clip thumbnail (C0001.THM) or a DJI drone flight log (DJI_0001.SRT). Not
// a media asset — tied to its video so it travels through import/export/purge.
export type AssetSidecar = {
  id: number;
  asset_id: number;
  abs_path: string;
  rel_path: string;
  filename: string;
  kind: "xml" | "thm" | "srt";
  file_size: number | null;
  created_at: string;
};

// The lightweight sidecar shape carried on a grid row (cf. assetQuery.ts): just
// what the viewer needs to list a clip's companions and link each to its
// per-file download endpoint (/api/sidecars/:id/download).
export type SidecarBrief = {
  id: number;
  kind: "xml" | "thm" | "srt";
  filename: string;
  // Parsed from a DJI .SRT flight log (cf. lib/srt.ts); null for xml/thm and for
  // any .srt we couldn't parse. Peak altitude in metres + telemetry sample count.
  maxAltitude?: number | null;
  sampleCount?: number | null;
};

export type Rating = {
  asset_id: number;
  verdict: Verdict;
  star: number;
  color_label: string | null;
  reviewed_at: string | null;
};

export type Tag = {
  id: number;
  name: string;
  color: string | null;
};

// Row returned by the cull grid (asset + joined verdict + tags + companion).
export type AssetGridRow = Asset & {
  verdict: Verdict;
  star: number;
  color_label: string | null;
  tags: string[];
  // Pairing (cf. lib/pairing.ts): the other member of this asset's group and the
  // group's kind. Null when the asset is not paired. Lets the viewer offer the
  // segmented toggle (describing whichever side is on screen, and playing the
  // .mov when the companion is a Live Photo's motion) and the grid badge the
  // pair — all without a second round-trip.
  companion_id: number | null;
  companion_ext: string | null;
  companion_media_type: "photo" | "video" | null;
  companion_filename: string | null;
  companion_file_size: number | null;
  companion_width: number | null;
  companion_height: number | null;
  group_kind: "raw_jpeg" | "live_photo" | null;
  // Number of sidecar files (Sony XML/THM, DJI .SRT) tied to this asset (0 for
  // most). Lets the viewer note that a clip carries its companion files.
  sidecar_count: number;
  // True when a DJI drone flight-log .SRT rides with this clip — drives the
  // grid's telemetry badge, distinct from a plain metadata companion.
  has_telemetry: boolean;
  // The sidecars themselves (for the viewer's detail row + download links).
  sidecars: SidecarBrief[];
  // Finals → sources counterpart (cf. lib/reconcile.ts), joined for the viewer's
  // before/after toggle. For an edited final: the source original's name/ext. For
  // a source: how many edits link to it, plus the first one's name/ext to jump to.
  // All NULL/0 when the asset has no counterpart.
  original_filename: string | null;
  original_ext: string | null;
  edit_count: number;
  first_edit_id: number | null;
  first_edit_filename: string | null;
  first_edit_ext: string | null;
};
