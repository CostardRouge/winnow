// The Unplaced view's shared vocabulary (docs/UNPLACED.md): the response shape
// of GET /api/assets/unplaced, the rules that produce it, and the pure folder
// grouping. Client-safe on purpose — the page prints UNPLACED_RULES and the
// server (src/lib/unplaced.ts) applies them, and neither may drift from the
// other. `pg` never enters this file; same split as features.ts / featureGate.ts.

// Every threshold the view relies on, in one place and RETURNED with the data
// so the page can print them. This repo's rule: an automatic decision nobody
// can see is one nobody trusts (the Timeline's granularity chip, the Heatmap's
// keeper-rate floor). The values are the brief's (§8) and the census that
// justified them, not tuned constants — change them here and the sentence on
// screen changes with them.
export const UNPLACED_RULES = {
  /** Folders whose capture windows come within this many hours share a card:
   * one folder = one memory card, so a two-body outing is two folders and one
   * trip, and the human should make one gesture. */
  gap_h: 2,
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

export type UnplacedSample = {
  id: number;
  ext: string;
  media_type: "photo" | "video";
};

// One folder inside a card.
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
  /** Stable id for React keys: the member session ids joined with "-". */
  key: string;
  sessions: UnplacedSession[];
  t0: string;
  t1: string;
  total: number;
  unplaced: number;
  exempt: number;
  no_exif: number;
  sample: UnplacedSample[];
  suggestion: UnplacedSuggestion | null;
};

export type UnplacedResponse = {
  groups: UnplacedGroup[];
  totals: { groups: number; unplaced: number; no_exif: number };
  rules: typeof UNPLACED_RULES;
};

// Merge sessions (sorted by captured_at_min ASC) whose capture windows overlap
// or come within `gapMs` of each other. A linear sweep: a session extends the
// current group when it starts before the group's latest end plus the gap.
// Pure, so the server groups with it and a test could too.
export function groupSessions<
  T extends { captured_at_min: string; captured_at_max: string | null },
>(rows: readonly T[], gapMs: number): T[][] {
  const groups: T[][] = [];
  let cur: T[] = [];
  let curEnd = -Infinity;
  for (const r of rows) {
    const start = Date.parse(r.captured_at_min);
    const end = Date.parse(r.captured_at_max ?? r.captured_at_min);
    if (cur.length && start <= curEnd + gapMs) {
      cur.push(r);
      curEnd = Math.max(curEnd, end);
    } else {
      if (cur.length) groups.push(cur);
      cur = [r];
      curEnd = end;
    }
  }
  if (cur.length) groups.push(cur);
  return groups;
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
