// Shapes shared by the /api/gear route and the /gear page. Kept apart from
// lib/gear.ts — which pulls in the server-only Postgres pool — so the client
// bundle can import the types without dragging the DB layer along (same split
// as exportTypes.ts / export.ts).

// The two halves of the library a piece of gear can have media in — the same
// split the Library tabs make (cf. lib/roles.ts): "incoming" is everything left
// to cull, "gallery" the finalized exports. A body/lens usually has frames in
// both, with different counts and different grids to link to, so every tally on
// the shelf is stored per source rather than merged into one number.
export type GearSource = "incoming" | "gallery";

/** One source's tally for a body or a lens. Zeroed when it has nothing there. */
export type GearStats = {
  /** Logical media (a RAW+JPEG pair counts once). */
  count: number;
  photos: number;
  videos: number;
  first_capture: string | null;
  last_capture: string | null;
};

export type GearLens = {
  /** Raw EXIF lens string — also the gallery filter value. */
  name: string;
  /** Focal range actually recorded in the EXIF — how a zoom betrays itself. */
  focal_min: number | null;
  focal_max: number | null;
  /** Fastest aperture recorded, i.e. observed rather than the marketing spec. */
  aperture_min: number | null;
  incoming: GearStats;
  gallery: GearStats;
};

export type GearCamera = {
  /** Raw EXIF device string ("Make Model") — the value the gallery filters on. */
  name: string;
  /** Display name, de-crypted where needed (cf. lib/cameraLabels.ts). */
  label: string;
  incoming: GearStats;
  gallery: GearStats;
  /** The glass this body was used with, busiest first. */
  lenses: GearLens[];
};

export type GearResponse = { cameras: GearCamera[] };

export const EMPTY_STATS: GearStats = {
  count: 0,
  photos: 0,
  videos: 0,
  first_capture: null,
  last_capture: null,
};
