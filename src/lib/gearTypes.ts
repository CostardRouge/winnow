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
  /** Canonical id the spellings below were merged on (cf. lib/lensLabels.ts). */
  key: string;
  /** Display name — the busiest spelling, tidied. Never a filter value. */
  label: string;
  /**
   * Every raw EXIF string that folded into this lens, busiest first. These ARE
   * the filter values: a card links on all of them (`?lens=a,b`), so its count
   * and the grid it opens hold the same frames.
   */
  names: string[];
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
  /**
   * The body's shutter odometer: highest mechanical actuation count any indexed
   * frame carries in its MakerNotes (Sony bodies stamp every frame with it).
   * A property of the BODY, not of a source — the same on both tabs. Null when
   * no frame carries the tag (phones, drones, unsupported makers).
   */
  shutter_count: number | null;
  /** Capture date of the freshest counted frame — how current the reading is. */
  shutter_count_at: string | null;
  /** Every medium carrying it was named by hand (`device_source = 'named'`,
   *  migration 0051): no file of the library spells this body. */
  named: boolean;
  /** Whose camera it is (migration 0053), or null: not sorted yet. */
  owner: GearOwner | null;
};

/** Whose a body is (cf. lib/gearOwners.ts). A body with none is "not sorted". */
export type GearOwnerKind = "mine" | "other" | "none";

export type GearOwner = {
  owner: GearOwnerKind;
  /** For 'other': the person of /people, when the row names one that exists. */
  person_id: number | null;
  /** For 'other': the person's current name, else the name typed by hand. */
  owner_name: string | null;
  /** For 'mine': the span it was the maintainer's, by capture date (YYYY-MM-DD),
   *  inclusive; null at either end = open. */
  owned_from: string | null;
  owned_until: string | null;
};

/** A named person the "Whose?" menu offers (People's named stacks). */
export type GearPerson = { id: number; name: string };

export type GearResponse = { cameras: GearCamera[]; people: GearPerson[] };

export const EMPTY_STATS: GearStats = {
  count: 0,
  photos: 0,
  videos: 0,
  first_capture: null,
  last_capture: null,
};
