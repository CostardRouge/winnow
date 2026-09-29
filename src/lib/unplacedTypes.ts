// The Unplaced view's shared vocabulary (docs/UNPLACED.md): the response shape
// of GET /api/assets/unplaced, the rules that produce it, and the pure folder
// sorting (shoot or container, and which folders were shot alongside which).
// Client-safe on purpose — the page prints UNPLACED_RULES and the
// server (src/lib/unplaced.ts) applies them, and neither may drift from the
// other. `pg` never enters this file; same split as features.ts / featureGate.ts.

// Every threshold the view relies on, in one place and RETURNED with the data
// so the page can print them. This repo's rule: an automatic decision nobody
// can see is one nobody trusts (the Timeline's granularity chip, the Heatmap's
// keeper-rate floor). The values are the brief's (§8) and the census that
// justified them, not tuned constants — change them here and the sentence on
// screen changes with them.
export const UNPLACED_RULES = {
  /** Folders whose capture windows come within this many hours of a card's
   * window were shot ALONGSIDE it: one folder = one memory card, so a
   * two-body outing is two folders and one trip. They are NOT merged into
   * the card — every card is one folder, the same folder its title opens —
   * but offered in its Place dialog as unticked rows, so the two-body day
   * stays one gesture and nothing joins the write unseen (docs/UNPLACED.md
   * §9.8: merging hid a 1 360-file folder behind "+ 1 more folder"). The
   * SAME silence cuts a container folder into parts (see span_max_h). */
  gap_h: 2,
  /** A folder whose OWN window is longer than this is not a shoot but a
   * container — a month, a year (the iPhone's `photos/2026/april 2026`). It
   * never merges with anything: the first real run had a 360-folder, two-year
   * card before this rule existed (docs/UNPLACED.md §9). Instead its unplaced
   * camera media are cut into PARTS at every gap_h silence, each a card with
   * its own suggestion. A container is never offered alongside another card
   * either: a month folder is "near" every shoot of its month. */
  span_max_h: 72,
  /** A container is cut into at most this many parts. Past it the folder's
   * stragglers are too scattered for a card list and it stays one card that
   * opens in the grid, where each day's neighbours are visible. */
  parts_max: 40,
  /** A suggestion's donors are the located frames within this many hours of
   * the card's own window — the phone in the pocket while the Sony shoots. */
  near_h: 1,
  /** Failing that, within this many hours: a frame from the same day, which
   * is a weaker witness and is said to be. */
  day_h: 24,
  /** Under this many donors a suggestion is shown but never pre-filled. */
  floor: 5,
  /** Share of donors in the dominant geocoding cell at/above which the
   * suggestion pre-fills the map with high confidence… */
  high: 0.9,
  /** …and medium confidence. Below: shown, not seeded. */
  medium: 0.6,
  /** Accepting the offered pin within this many metres records 'inferred';
   * moving it further records 'manual' — the human placed it. */
  move_m: 100,
} as const;

export type UnplacedConfidence = "high" | "medium" | "low";

/** What a card stands for, and therefore what Place applies to:
 *  - `shoot`: one short folder — every live media of it (plus, only if ticked
 *    in the dialog, the folders shot alongside it: `siblings`);
 *  - `part`: one time-slice of a container folder — the folder's media
 *    captured inside [t0, t1];
 *  - `span`: a container folder as a whole, or what is left of one once its
 *    parts are cut out (media with no camera EXIF, or no capture time), or one
 *    too scattered to cut (see `moments`) — no time suggestion, ever: a month
 *    of located frames points at a month of places. */
export type UnplacedKind = "shoot" | "part" | "span";

export type UnplacedSample = {
  id: number;
  ext: string;
  media_type: "photo" | "video";
};

// One folder inside a card. On a `part` card the tallies are still the whole
// folder's — the card's own are on the group.
export type UnplacedSession = {
  id: number;
  name: string;
  device_hint: string | null;
  captured_at_min: string;
  captured_at_max: string | null;
  /** Live media in the folder. */
  total: number;
  /** No position and not exempted — what the card is about. */
  unplaced: number;
  /** Marked as never needing a position. */
  exempt: number;
  /** Unplaced media with neither camera_model nor lens — the census's
   * discriminator for screenshots and scans (docs/UNPLACED.md §2). */
  no_exif: number;
  sample: UnplacedSample[];
};

// A short folder shot within gap_h of a card's window — offered, unticked, in
// that card's Place dialog. Its own card still exists; placing it from here
// only saves the second gesture.
export type UnplacedSibling = {
  id: number;
  name: string;
  device_hint: string | null;
  captured_at_min: string;
  captured_at_max: string | null;
  total: number;
  unplaced: number;
};

export type UnplacedSuggestion = {
  lat: number;
  lon: number;
  /** The dominant geocoding cell's name, or null when it was never resolved
   * (the coordinates still stand). */
  name: string | null;
  /** How many trustworthy located frames were found in the window. */
  located: number;
  /** Share of them in the dominant cell, 0–1. */
  share: number;
  confidence: UnplacedConfidence;
  /** Which window found the donors. */
  window: "near" | "day";
  /** The body that shot most of the donors, when known. */
  donor_model: string | null;
};

export type UnplacedGroup = {
  /** Stable id for React keys: the folder's session id, plus ":n" for the
   * n-th part of a container. */
  key: string;
  kind: UnplacedKind;
  /** The card's folder — always exactly one. An array because every consumer
   *  (the targets request, the grid link, the device line) reads it as one. */
  sessions: UnplacedSession[];
  /** Short folders shot alongside (within gap_h of the card's window), for
   *  the dialog's unticked rows. Empty on a span. */
  siblings: UnplacedSibling[];
  /** The card's capture window — the folders' for a shoot, the slice's for a
   * part, the folder's for a span. */
  t0: string;
  t1: string;
  /** Live media the card covers (inside the window for a part). */
  total: number;
  unplaced: number;
  exempt: number;
  no_exif: number;
  sample: UnplacedSample[];
  suggestion: UnplacedSuggestion | null;
  /** On a part: which one of how many, 1-based, in time order. */
  part: { index: number; count: number } | null;
  /** On a span that was NOT cut: how many separate moments (gap_h apart) its
   * unplaced camera media fall into — set only when that is above parts_max,
   * the reason it stayed one card. */
  moments: number | null;
};

export type UnplacedTotals = {
  groups: number;
  /** Over the whole Incoming library, live media only — the progress bar. */
  placed: number;
  unplaced: number;
  exempt: number;
  /** Unplaced media with no camera EXIF, summed over the cards. */
  no_exif: number;
  /** Cards whose suggestion is confident enough to pre-fill the map. */
  ready: number;
  /** Cards that need a hand: low confidence, no donor, or a span. */
  by_hand: number;
};

export type UnplacedResponse = {
  groups: UnplacedGroup[];
  totals: UnplacedTotals;
  rules: typeof UNPLACED_RULES;
};

// Sort folders into the two families: a SHOOT (its own window at most
// `maxSpanMs`) or a SPAN (a container — a month, a year). No merging: every
// folder is its own card, the folder its title opens and its count describes.
// Pure, so the server sorts with it and a test could too.
export function splitSessions<
  T extends { captured_at_min: string; captured_at_max: string | null },
>(rows: readonly T[], maxSpanMs: number): { row: T; kind: "shoot" | "span" }[] {
  return rows.map((row) => {
    const start = Date.parse(row.captured_at_min);
    const end = Date.parse(row.captured_at_max ?? row.captured_at_min);
    return { row, kind: end - start > maxSpanMs ? "span" : "shoot" };
  });
}

// The shoots whose windows come within `gapMs` of [t0, t1] — the folders shot
// alongside a card. DIRECT neighbours only, never the chain of their
// neighbours: a chain is exactly how a monthly folder once bridged 360
// folders into one card (§9.1). `exceptId` is the card's own folder.
export function siblingsWithin<
  T extends { id: number; captured_at_min: string; captured_at_max: string | null },
>(
  window: { t0: string; t1: string },
  shoots: readonly T[],
  gapMs: number,
  exceptId: number,
): T[] {
  const a0 = Date.parse(window.t0) - gapMs;
  const a1 = Date.parse(window.t1) + gapMs;
  return shoots.filter((s) => {
    if (s.id === exceptId) return false;
    const b0 = Date.parse(s.captured_at_min);
    const b1 = Date.parse(s.captured_at_max ?? s.captured_at_min);
    return b0 <= a1 && b1 >= a0;
  });
}

// Confidence from the donor count and the dominant cell's share, per the
// rules above. Kept beside them so the two never disagree.
export function suggestionConfidence(
  located: number,
  share: number,
): UnplacedConfidence {
  if (located < UNPLACED_RULES.floor) return "low";
  if (share >= UNPLACED_RULES.high) return "high";
  if (share >= UNPLACED_RULES.medium) return "medium";
  return "low";
}

/** Whether a card's suggestion is good enough to pre-fill the map. */
export function isReady(g: UnplacedGroup): boolean {
  return (
    g.kind !== "span" &&
    g.suggestion != null &&
    g.suggestion.confidence !== "low"
  );
}

/** A card whose every unplaced media has no camera EXIF — screenshots, scans:
 * nothing there wants a position, and its one gesture is Exempt. */
export function isAllNoExif(g: UnplacedGroup): boolean {
  return g.unplaced > 0 && g.no_exif === g.unplaced;
}

// The order the backlog is worked in: what can be confirmed at a glance
// first (high, then medium), then what needs a look, then what needs a hand
// (no donor, or a span). Within a tier, the biggest pile first.
export function groupTier(g: UnplacedGroup): number {
  if (g.kind === "span") return 4;
  const c = g.suggestion?.confidence;
  return c === "high" ? 0 : c === "medium" ? 1 : c === "low" ? 2 : 3;
}

// Great-circle distance in metres (haversine) — the page uses it to decide
// whether the pin was accepted as offered or moved.
export function distanceM(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Web-Mercator tile holding a point at zoom `z`, plus where the point falls
// inside it (0–1 on each axis) — what a static one-tile preview needs to
// centre itself on the point without a map library. Latitude is clamped to
// the projection's bounds so a bad coordinate cannot produce NaN.
export function tileFor(
  lat: number,
  lon: number,
  z: number,
): { z: number; x: number; y: number; fx: number; fy: number } {
  const n = 2 ** z;
  const clampedLat = Math.max(-85.0511, Math.min(85.0511, lat));
  const xf = ((lon + 180) / 360) * n;
  const latR = (clampedLat * Math.PI) / 180;
  const yf =
    ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n;
  const x = Math.floor(xf);
  const y = Math.floor(yf);
  return { z, x, y, fx: xf - x, fy: yf - y };
}
