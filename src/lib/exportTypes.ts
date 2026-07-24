// Export file taxonomy, shared by the server (lib/export.ts, api/export*) and
// the client (the export modal's file picker). Kept free of any Node import so
// "use client" components can consume it.
//
// An export is no longer "the RAW picks": the selection is scanned and every
// candidate file lands in exactly ONE category below. The user then checks the
// categories that should travel (params.include on the export job). Categories
// are fixed; which ones the modal SHOWS is dynamic — a row only appears when
// the selection actually holds files of that kind.

export const EXPORT_CATEGORIES = [
  // Originals — the keepers of the selection.
  "raw", // RAW photos: pair keepers (.ARW…) + standalone RAWs (.DNG…)
  "photo", // direct photos that are NOT the JPEG side of a RAW pair (HEIC…)
  "video", // video originals (not a Live Photo's motion)
  // Companions — the optional other half of a pair (cf. lib/pairing.ts).
  "pair_jpeg", // the direct JPEG/HIF primary of a raw_jpeg pair
  "live_motion", // the .mov companion of a live_photo pair
  // Sidecars — satellite files tied to a clip (cf. lib/sidecars.ts).
  "sidecar_srt", // DJI drone flight logs (.SRT telemetry)
  "sidecar_meta", // camera metadata companions (.XML / .THM)
] as const;

export type ExportCategory = (typeof EXPORT_CATEGORIES)[number];

// Which categories travel. Always fully spelled out when sent by the modal;
// the worker overlays whatever subset it receives onto the legacy-derived
// defaults, so a hand-crafted API call with a partial map stays predictable.
export type ExportInclude = Partial<Record<ExportCategory, boolean>>;

// One aggregated row of the export plan (the modal's dynamic scan): everything
// the selection holds in `category`, with the per-extension breakdown.
export type ExportPlanGroup = {
  category: ExportCategory;
  count: number;
  bytes: number;
  exts: Array<{ ext: string; count: number }>;
};

export type ExportPlan = {
  // Files with sidecar_id == null (the media themselves).
  assets: number;
  groups: ExportPlanGroup[];
};

// Display metadata, in render order. `section` clusters the rows; a section
// with no matching group is simply not rendered.
export const EXPORT_CATEGORY_META: Record<
  ExportCategory,
  { section: "Originals" | "Companions" | "Telemetry & metadata"; label: string; hint: string }
> = {
  raw: {
    section: "Originals",
    label: "RAW photos",
    hint: "The raw source files",
  },
  photo: {
    section: "Originals",
    label: "Photos",
    hint: "Direct photos (not part of a RAW pair)",
  },
  video: {
    section: "Originals",
    label: "Videos",
    hint: "Video clips",
  },
  pair_jpeg: {
    section: "Companions",
    label: "JPEG/HIF of RAW pairs",
    hint: "The direct file shot next to each RAW",
  },
  live_motion: {
    section: "Companions",
    label: "Live Photo motion",
    hint: "The .mov clip behind each Live Photo",
  },
  sidecar_srt: {
    section: "Telemetry & metadata",
    label: "Drone flight logs",
    hint: "DJI .SRT telemetry (GPS, altitude…)",
  },
  sidecar_meta: {
    section: "Telemetry & metadata",
    label: "Camera metadata",
    hint: "XML/THM companions written by the camera",
  },
};

export const EXPORT_SECTIONS = [
  "Originals",
  "Companions",
  "Telemetry & metadata",
] as const;
