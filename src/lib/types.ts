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
  created_at: string;
  updated_at: string;
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

// A Sony video sidecar (cf. lib/sidecars.ts): the small metadata/thumbnail
// companion the camera writes next to a clip (C0001M01.XML / C0001.THM). Not a
// media asset — tied to its video so it travels through import/export/purge.
export type AssetSidecar = {
  id: number;
  asset_id: number;
  abs_path: string;
  rel_path: string;
  filename: string;
  kind: "xml" | "thm";
  file_size: number | null;
  created_at: string;
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
  // ML-assisted culling (asset_analysis, cf. lib/analyze.ts). All null until the
  // ML pass has run on this photo. `sharpness` is the variance-of-Laplacian
  // score (higher = sharper); `near_dup_cluster_id` ties the photo to its
  // look-alikes (null = no near-duplicate found); `ml_status` is the analysis
  // lifecycle.
  sharpness: number | null;
  near_dup_cluster_id: number | null;
  ml_status: "pending" | "processing" | "ready" | "error" | null;
  // Number of Sony sidecar files (XML/THM) tied to this asset (0 for most).
  // Lets the viewer note that a clip carries its camera metadata companion.
  sidecar_count: number;
};
