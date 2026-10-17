// The SQL predicates the Unplaced view is built on (docs/UNPLACED.md), written
// once so the cards (lib/unplaced.ts), the set-aside lists
// (lib/unplacedAside.ts) and the geotag targets route agree on what a media
// is. Each takes the asset row as `a`. Server-only: plain strings, but they
// only mean something next to `pg`.

// The Incoming scope: not a finals root, not an ignored folder, a live row.
export const INCOMING_FROM = `
  FROM assets a
  JOIN sessions s  ON s.id  = a.session_id
  JOIN roots    rt ON rt.id = s.root_id`;
export const INCOMING_WHERE = `rt.kind <> 'finals' AND s.ignored = false AND a.deleted_at IS NULL`;

// "No position, not exempted" — the backlog predicate, and the one
// assets_geo_todo_idx (0042) serves.
export const TODO = `a.gps_lat IS NULL AND a.geo_exempt_at IS NULL`;

// The census's discriminator for screenshots and scans (docs/UNPLACED.md §2).
// It reads the CURRENT camera_model, which an attribution may have filled
// (deviceAttribution.ts) — the set-aside rules below read what the file says.
export const NO_EXIF = `a.camera_model IS NULL AND a.lens IS NULL`;

// What the FILE says about a camera: no lens and no model of its own
// (camera_model_exif, 0048 — NULL where the file names nothing, whatever an
// attribution filled in beside it). A phone's own photo always names both.
const NO_CAMERA_IN_FILE = `a.lens IS NULL AND a.camera_model_exif IS NULL`;

// The three kinds of media set aside from the cards (§12). Measured on the
// instance, 2026-10-16: 45 + 53 + 108 of 820 unplaced, 51 of 141 cards.
//
// A SCREENSHOT: a PNG whose file names no camera. Phones save photos as
// HEIC/JPEG, never PNG; 43 of the 45 were exactly the iPhone 15 Pro Max's
// screen (1290 × 2796).
export const SCREENSHOT = `(lower(a.ext) IN ('.png', 'png') AND ${NO_CAMERA_IN_FILE})`;
// SAVED FROM ANOTHER APP: the name iOS gives media it imports from elsewhere
// (WhatsApp, Instagram, an editor) — four capitals and four digits, an E
// before the digits for an edit, " 1" for a copy: RSJQ2434.MP4,
// EJQME2111.MOV, YKSD4842 1.MOV — and no camera in the file. Its time is the
// save, not the shot, and it carries no position by construction.
export const SAVED = `(a.filename ~ '^[A-Z]{4}E?[0-9]{4}( [0-9]+)?\\.[A-Za-z0-9]+$' AND ${NO_CAMERA_IN_FILE})`;
// A GRADED EXPORT: `<source>_lut_<YYYYMMDD>.<ext>`, the maintainer's export
// naming. Its capture time is the EXPORT's, so the frames shot "in the same
// hours" are where it was graded, not where it was shot — 62 drone clips were
// suggested at Venus Bay, where they were edited. Its position comes from its
// source clip instead (lib/unplacedAside.ts), never from the time.
export const GRADED = `(a.filename ~* '_lut_[0-9]{8}\\.[a-z0-9]+$')`;

export const ASIDE = `(${SCREENSHOT} OR ${SAVED} OR ${GRADED})`;

// Which kind, as a column: NULL for a media a card may place.
export const ASIDE_KIND = `CASE WHEN ${GRADED} THEN 'graded'
                                WHEN ${SCREENSHOT} THEN 'screenshot'
                                WHEN ${SAVED} THEN 'saved' END`;

// The backlog a CARD covers: unplaced, and not set aside.
export const TODO_CARD = `${TODO} AND NOT ${ASIDE}`;
