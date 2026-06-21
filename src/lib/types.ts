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
  ignored: boolean;
  // Visual "done" flag (Incoming tab). Does not affect processing.
  completed: boolean;
};

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

export type Verdict = "pick" | "reject" | "unrated";

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
  // RAW+JPEG pairing (cf. lib/pairing.ts). `group_id` ties a RAW and its direct
  // JPEG/HEIF companion together; `group_role` says which side this file is.
  // The `primary` (direct file) is shown by default; the `companion` (RAW) is
  // the reachable "source brute". Both null when the file is not paired.
  group_id: number | null;
  group_role: "primary" | "companion" | null;
  created_at: string;
  updated_at: string;
};

// A media group: the link between a RAW "source" and its direct JPEG/HEIF
// companion shot together by the camera. One row per logical pair.
export type AssetGroup = {
  id: number;
  session_id: number;
  kind: "raw_jpeg";
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

// Row returned by the cull grid (asset + joined verdict + tags).
export type AssetGridRow = Asset & {
  verdict: Verdict;
  star: number;
  color_label: string | null;
  tags: string[];
};
