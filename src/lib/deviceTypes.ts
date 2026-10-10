// Device attribution's shared vocabulary (cf. lib/deviceAttribution.ts): the
// shapes GET/POST /api/pipeline/device-attribution answer with, which the
// Devices page and the grids' "Set camera body…" dialog read. Client-safe on
// purpose — `pg` never enters this file. Before it existed both client files
// imported these types from the DB-backed module, a boundary that held only
// because the imports were `import type` (docs/CODEBASE-AUDIT.md ARC-05). Same
// split as unplacedTypes.ts / duplicateTypes.ts.

// One piece of evidence that a candidate belongs to a given body.
export type DeviceSignal =
  | "telemetry" // a tied .SRT sidecar whose DJI flight log actually parsed
  | "sidecar" // a tied .SRT sidecar, parsed or not
  | "filename" // the maker's own naming scheme (DJI_0001.MP4)
  | "sibling" // another live asset of the SAME folder already has a body
  | "folder"; // the folder path names the gear ("dji drone", "drone")

/** A body the library already knows, as the gear dimension spells it. */
export type KnownBody = {
  /** The raw EXIF string — the value every grid filters on. Never a label. */
  device: string;
  /** The bare model, carried along so an attributed row matches its siblings. */
  camera_model: string | null;
  /** How many live media already carry it (busiest first in the picker). */
  count: number;
};

/** A medium carrying no body, with the evidence gathered about it — plus the
 *  facts the opened folder's table prints and the viewer needs to draw it.
 *
 *  What is NOT here, because Winnow does not index it: codec, frame rate and
 *  the stream's nominal bitrate. Nothing in the pipeline calls ffprobe — the
 *  derivative worker hands the file straight to ffmpeg — so those would need a
 *  column and a pass of their own. The table derives an AVERAGE bitrate from
 *  size over duration instead, and says so. */
export type DeviceCandidate = {
  id: number;
  filename: string;
  rel_path: string;
  ext: string;
  media_type: "photo" | "video";
  file_size: number | null;
  width: number | null;
  height: number | null;
  duration_s: number | null;
  derivative_status: string;
  captured_at: string | null;
  session_name: string | null;
  signals: DeviceSignal[];
  score: number;
  /** True once `score` clears CONFIDENT_SCORE — the UI pre-selects these. */
  confident: boolean;
  /** The body the vote proposes, or null when nothing named one. */
  suggested_device: string | null;
  suggested_camera_model: string | null;
};

/** A thumbnail the card's strip draws — the same shape Unplaced's cards use. */
export type DeviceSample = {
  id: number;
  ext: string;
  media_type: "photo" | "video";
};

/** One folder with media waiting for a body: a card on the Devices page. */
export type DeviceFolder = {
  session_id: number;
  name: string;
  source_path: string;
  /** Media in this folder carrying no body — what the card's verb acts on. */
  total: number;
  photos: number;
  videos: number;
  /** How many of them the vote is confident about (score >= CONFIDENT_SCORE). */
  confident: number;
  first_capture: string | null;
  last_capture: string | null;
  /** The signals carried by MORE THAN HALF the folder — what the card prints.
   *  A signal two files out of 129 carry says nothing about the folder. */
  signals: DeviceSignal[];
  suggested_device: string | null;
  suggested_camera_model: string | null;
  sample: DeviceSample[];
};

/** How folders are ordered on the page. */
export type FolderSort = "size" | "recent";

/** What every write answers. */
export type ApplyResult = {
  /** Rows whose body actually changed. */
  updated: number;
  /** Ids that matched nothing to write — already carrying that body (or, for a
   *  fill, any body), not live, or (in suggestion mode) with no proposal. */
  skipped: number;
};

/** What a pass of the clip probe did (lib/deviceProbe.ts, migration 0049). */
export type ProbeReport = {
  /** Clips read, whatever they held. */
  probed: number;
  /** Had no body; now carry the one their track names. */
  filled: number;
  /** An attributed body (vote or hand-fill) the track agrees with. */
  confirmed: number;
  /** An attributed body the track contradicts — the track's value won. */
  corrected: number;
  /** A human override, kept; the track's value recorded beside it. */
  overridden: number;
  /** A DJI header naming no camera this reader knows (another product). */
  untold: number;
  /** No DJI metadata track at all — a phone clip, an edit, an export. */
  noTrack: number;
  /** Could not be read (missing, unmounted): left unread for the next pass. */
  unreadable: number;
  /** Paused (the scan's pause) before the backlog was through. */
  stopped: boolean;
  /** Clips still never read once the pass ended. */
  remaining: number;
  /** The bodies the track contradicted, first ones only. */
  corrections: { id: number; filename: string; from: string | null; to: string }[];
  /** Clips per camera the tracks named — WHICH body, not only how many. */
  cameras: Record<string, number>;
};
