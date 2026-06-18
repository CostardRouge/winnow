// Types des lignes Postgres (miroir du schéma §5).

export type Root = {
  id: number;
  path: string;
  kind: "source" | "finals";
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
  created_at: string;
  updated_at: string;
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

// Ligne renvoyée par la grille de tri (asset + verdict joint + tags).
export type AssetGridRow = Asset & {
  verdict: Verdict;
  star: number;
  color_label: string | null;
  tags: string[];
};
