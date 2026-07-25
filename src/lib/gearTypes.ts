// Shapes shared by the /api/gear route and the /gear page. Kept apart from
// lib/gear.ts — which pulls in the server-only Postgres pool — so the client
// bundle can import the types without dragging the DB layer along (same split
// as exportTypes.ts / export.ts).

export type GearCamera = {
  /** Raw EXIF device string ("Make Model") — the value the gallery filters on. */
  name: string;
  /** Display name, de-crypted where needed (cf. lib/cameraLabels.ts). */
  label: string;
  /** Logical media shot with this body (a RAW+JPEG pair counts once). */
  count: number;
  photos: number;
  videos: number;
  first_capture: string | null;
  last_capture: string | null;
  /** Most-used lens on this body, when the files carry a lens tag. */
  top_lens: string | null;
};

export type GearLens = {
  /** Raw EXIF lens string — also the gallery filter value. */
  name: string;
  count: number;
  photos: number;
  videos: number;
  first_capture: string | null;
  last_capture: string | null;
  /** Focal range actually recorded in the EXIF — how a zoom betrays itself. */
  focal_min: number | null;
  focal_max: number | null;
  /** Fastest aperture recorded, i.e. observed rather than the marketing spec. */
  aperture_min: number | null;
  /** Body this lens spent most of its frames on. */
  top_body: string | null;
};

export type GearResponse = { cameras: GearCamera[]; lenses: GearLens[] };
