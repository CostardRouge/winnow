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
  /** A card's located frames, read in time order, that move further than
   * this from where a run of them started have changed PLACE: the card gets
   * one STOP per place, each with its own window and suggestion, placed from
   * one dialog. A shoot is not one place just because it is one folder — a
   * day out that visits two towns put the second town's frames at the first
   * one's median (docs/UNPLACED.md §10–§11). The geocoding cell's own default
   * size, so "another place" means what the cells already mean. Also the
   * radius a followed track's frames must stay within to share a stop. */
  split_km: 5,
  /** A place needs at least this many located frames to make a stop: one
   * phone frame with a wild fix, or a friend's photo from elsewhere, must not
   * split a folder in two. */
  split_min: 2,
  /** The Place dialog lists the positions already applied by hand or by an
   * accepted suggestion within this many days of the card — "same place as
   * the folder I did yesterday" as one click. Offered, never pre-filled. */
  reuse_d: 30,
  /** A followed track's stretch shorter than this many minutes is a place
   * the photographer PASSED, not one they stayed at: passes that follow each
   * other join into one "on the move" stop instead of a stop every 5 km of a
   * drive. */
  stay_min: 30,
  /** Two stops of one card that would need travelling faster than this
   * (an airliner cruises at ~900 km/h) are not two places: the located
   * frames DISAGREE — one source has a wrong clock or time zone. Such a card
   * is not split, its suggestion is not offered as a pin, and it says which
   * places disagree (2026-10-13: a drone folder on the instance was cut into
   * Porto and Melbourne two hours apart). */
  max_kmh: 1000,
  /** Confidence by DISTANCE (docs/UNPLACED.md §12): the located frame just
   * before a card and the one just after it, each within near_h, that lie
   * within this many kilometres of each other — and of every located frame
   * inside the card's hours — BRACKET it: high, whatever the donor count or
   * the cell share say. One side only, or the card's own hours only: medium.
   * Measured on the instance (2026-10-16): 198 media whose evidence sat
   * within 2 km read "low" — under `floor` donors, or donors either side of
   * a cell boundary 500 m away — among them a clip shot 1 min 30 s between
   * two Sony frames taken at the same spot. */
  tight_km: 2,
  /** EACH FRAME BY ITS NEIGHBOURS (docs/UNPLACED.md §13): a frame takes the
   * located frames just before and after ITS OWN minute, not the card's
   * hours — between two of them at most this many minutes apart
   * (interpolated, never faster than `frame_kmh`)… */
  frame_bracket_min: 60,
  /** …or two at the same spot (within tight_km) up to this many hours apart —
   * the photographer stayed put in between… */
  frame_still_h: 12,
  /** …or the nearest one within this many minutes. Else nothing: a gap is
   * not a position. The import's own defaults (trackParse.positionAt), the
   * ones "Follow a track…" already applied to the phone's frames. Measured on
   * the instance (2026-10-17): 406 of the 691 media on cards that were not
   * Ready, all 280 of *sunrise beach* among them. */
  frame_nearest_min: 15,
  frame_kmh: 200,
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
  /** Set when the frames nearest in time decided the confidence (tight_km)
   *  rather than the cell share — the pin is then the nearest of them. */
  evidence?: UnplacedEvidence | null;
};

/** A located frame next to a card, as its evidence names it. */
export type EvidenceFix = {
  at: string;
  filename: string;
  model: string | null;
  name: string | null;
  lat: number;
  lon: number;
};

/** Why a card reads high or medium by distance (tight_km):
 *  - `bracketed`: a located frame within near_h before AND after the card,
 *    both within tight_km of each other and of any inside it → high;
 *  - `one_side`: on one side only → medium;
 *  - `inside`: none around it, but its own hours hold located frames, all
 *    within tight_km → medium. */
export type UnplacedEvidence = {
  basis: "bracketed" | "one_side" | "inside";
  before: EvidenceFix | null;
  after: EvidenceFix | null;
  /** Located frames inside the card's own hours. */
  inside: number;
  /** The widest distance between any two of them, metres. */
  spread_m: number;
};

/** One stop of a card whose located frames move: a time window into the
 *  card's folder, its tallies, and its own suggestion. */
export type UnplacedStop = {
  index: number;
  /** The stop's window: from cut to cut, tiling the card. */
  t0: string;
  t1: string;
  /** Its first and last unplaced frame — what the card prints. */
  first: string | null;
  last: string | null;
  total: number;
  unplaced: number;
  no_exif: number;
  sample: UnplacedSample[];
  suggestion: UnplacedSuggestion;
};

/** Two places a card's located frames put it in, too far apart for the time
 *  between them (max_kmh). */
export type UnplacedConflict = {
  /** Each side's place and the body that shot most of its frames — the
   *  device whose clock to check. */
  a: { name: string | null; lat: number; lon: number; model: string | null };
  b: { name: string | null; lat: number; lon: number; model: string | null };
  km: number;
  /** Hours between the last frame at `a` and the first at `b`. */
  hours: number;
};

/** What placing a card frame by frame would do (§13). */
export type UnplacedNeighbours = {
  /** Frames of the card the located frames around them place. */
  placed: number;
  /** Frames of the card (camera media, not set aside). */
  total: number;
  /** How many places those positions make (stops, split_km). */
  places: number;
  /** Whether every placed frame lies within split_km of the card's own
   *  suggestion — null when there is none, or the card has stops. False
   *  takes the card out of Ready: one pin for the folder would be wrong. */
  agrees: boolean | null;
};

/** The nearest human placement to a card with no suggestion. */
export type UnplacedNearest = {
  lat: number;
  lon: number;
  /** "Lège-Cap-Ferret, France", once geocoded. */
  name: string | null;
  /** The folder that placement was made in. */
  folder: string;
  /** Hours from the card's window, negative before it. */
  gap_h: number;
  /** Hand-placed ('manual') rather than an accepted suggestion. */
  verified: boolean;
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
  /** On a card whose located frames move (split_km): its stops, in time
   * order — two or more, each a window into the card with its own
   * suggestion. The card stays ONE card (the folder is one thing you opened)
   * and its Place opens the stops dialog. Such a card offers no siblings:
   * the other body's folder spans the same places, and offering it whole
   * would put both towns at one point again. */
  stops: UnplacedStop[] | null;
  /** The located frames around the card put it in two places no one could
   *  travel between in the time (max_kmh): set instead of `stops`, and the
   *  card's suggestion is then low and never pre-filled. */
  conflict: UnplacedConflict | null;
  /** On a card with no suggestion: the nearest position a human already
   * applied, within reuse_d days — "same place as the folder I did
   * yesterday", shown on the card and one click away. */
  nearest: UnplacedNearest | null;
  /** Each frame matched against the located frames around ITS OWN minute
   * (§13) — set on every shoot and part with no conflict, when at least one
   * frame finds a position. */
  neighbours: UnplacedNeighbours | null;
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
  /** Unplaced media set aside from the cards (§12) — counted in `unplaced`,
   *  on no card: screenshots, files saved from another app, graded exports. */
  aside: UnplacedAsideTotals;
};

export type UnplacedAsideTotals = {
  screenshots: number;
  saved: number;
  graded: number;
  /** Graded exports whose source clip was found, already placed. */
  graded_matched: number;
};

/** Why a media is set aside from the cards (docs/UNPLACED.md §12). */
export type AsideKind = "screenshot" | "saved" | "graded";

/** One media the "Not a place" dialog lists. */
export type AsideMedia = {
  id: number;
  session_id: number;
  folder: string;
  filename: string;
  media_type: "photo" | "video";
  captured_at: string | null;
  kind: "screenshot" | "saved";
};

/** A graded export and the clip it was exported from. */
export type GradedExport = {
  id: number;
  session_id: number;
  folder: string;
  filename: string;
  media_type: "photo" | "video";
  /** The export's own date — the grading day, not the shoot's. */
  captured_at: string | null;
  /** The source clip, when exactly one position answers for it. */
  source: {
    id: number;
    rel_path: string;
    captured_at: string | null;
    lat: number;
    lon: number;
    name: string | null;
  } | null;
  /** Why there is no source: nothing by that name and day, or several
   *  located clips that disagree on where. */
  reason: "none" | "ambiguous" | null;
};

export type UnplacedAsideResponse = {
  not_a_place: AsideMedia[];
  graded: GradedExport[];
  /** Each list stops at this many rows; `truncated` says one did. */
  cap: number;
  truncated: boolean;
};

export type UnplacedResponse = {
  groups: UnplacedGroup[];
  totals: UnplacedTotals;
  rules: typeof UNPLACED_RULES;
};

/** A position already applied by a human near a card's dates (reuse_d) —
 *  GET /api/assets/unplaced/places. One spot = one coordinate to 4 decimals
 *  (~10 m): a bulk placement writes ONE coordinate for a whole folder. */
export type UnplacedPlace = {
  lat: number;
  lon: number;
  /** "Pérols, France", from the geocoded media at that spot; null until the
   *  geocoder has reached them. */
  name: string | null;
  /** Media placed at that spot. */
  count: number;
  /** Hours between the card's window and the nearest media placed there —
   *  0 when one falls inside it; negative before the window, positive after. */
  gap_h: number;
  /** Any of them hand-placed ('manual'), rather than all accepted suggestions. */
  verified: boolean;
};

// How the list of cards is ordered — a URL parameter (`?sort=`), so a reload
// keeps it. `size` is the default: the maintainer works the biggest folders
// first, and a container cut into parts keeps its parts together, in time
// order.
export type UnplacedSort = "size" | "ready" | "newest" | "oldest";

export function parseUnplacedSort(v: string | null | undefined): UnplacedSort {
  return v === "ready" || v === "newest" || v === "oldest" ? v : "size";
}

export function sortGroups(
  groups: readonly UnplacedGroup[],
  sort: UnplacedSort,
): UnplacedGroup[] {
  const t = (g: UnplacedGroup) => Date.parse(g.t0);
  const out = [...groups];
  switch (sort) {
    case "ready":
      return out.sort(
        (a, b) =>
          groupTier(a) - groupTier(b) || b.unplaced - a.unplaced || t(a) - t(b),
      );
    case "newest":
      return out.sort((a, b) => t(b) - t(a));
    case "oldest":
      return out.sort((a, b) => t(a) - t(b));
    case "size":
      // The FOLDER's unplaced count — a session's tallies are the whole
      // folder's on every card it appears on — so the parts of the biggest
      // folder come first and stay together, then the next folder.
      return out.sort(
        (a, b) =>
          b.sessions[0].unplaced - a.sessions[0].unplaced ||
          a.sessions[0].id - b.sessions[0].id ||
          t(a) - t(b),
      );
  }
}

// One trustworthy located frame near a card, as the place split reads it.
export type UnplacedDonor = {
  /** Capture instant, epoch ms. */
  at: number;
  lat: number;
  lon: number;
  /** Geocoding cell (place_id); null when not geocoded yet. */
  cell: number | null;
  /** The cell's name, when resolved. */
  name: string | null;
  model: string | null;
};

/** A stretch of a card's located frames that stays in one place. */
export type PlaceRun = { first: number; last: number; donors: UnplacedDonor[] };

// Read the located frames in time order and cut wherever one lands further
// than `splitM` from the frame that opened the current run. Then the noise
// goes: a run of fewer than `minDonors` frames is dropped (a wild fix, a
// stray frame from someone else's phone), and two runs left side by side in
// the same place are joined back (the stray had cut one stay in two). Pure.
export function placeRuns(
  donors: readonly UnplacedDonor[],
  splitM: number,
  minDonors: number,
): PlaceRun[] {
  const sorted = [...donors].sort((a, b) => a.at - b.at);
  const raw: PlaceRun[] = [];
  for (const d of sorted) {
    const cur = raw[raw.length - 1];
    if (cur && distanceM(cur.donors[0], d) <= splitM) {
      cur.donors.push(d);
      cur.last = d.at;
    } else {
      raw.push({ first: d.at, last: d.at, donors: [d] });
    }
  }
  const out: PlaceRun[] = [];
  for (const r of raw) {
    if (r.donors.length < minDonors) continue;
    const prev = out[out.length - 1];
    if (prev && distanceM(prev.donors[0], r.donors[0]) <= splitM) {
      prev.donors.push(...r.donors);
      prev.last = r.last;
    } else {
      out.push({ ...r, donors: [...r.donors] });
    }
  }
  return out;
}

// The first pair of consecutive places no one could travel between in the
// time: from the last frame of one to the first of the next, faster than
// `maxKmh`. Null when every leg is possible. A minute's floor on the time, so
// two frames at the same instant in two places read as impossible, not as a
// division by zero. Pure.
export function impossibleLeg(
  runs: readonly PlaceRun[],
  maxKmh: number,
): { k: number; km: number; hours: number } | null {
  for (let k = 0; k + 1 < runs.length; k++) {
    const a = runs[k].donors[runs[k].donors.length - 1];
    const b = runs[k + 1].donors[0];
    const km = distanceM(a, b) / 1000;
    const hours = Math.max(b.at - a.at, 60_000) / 3_600_000;
    if (km / hours > maxKmh) return { k, km, hours };
  }
  return null;
}

// Where to cut between two consecutive places: in the longest silence of the
// card's own media between the last frame of one place and the first of the
// next — the drive happened while the camera was down. With no media in
// between, the midpoint. `media` is the card's unplaced camera media, epoch
// ms, ascending. Returns one instant per boundary, ascending. Pure.
export function placeCuts(runs: readonly PlaceRun[], media: readonly number[]): number[] {
  const cuts: number[] = [];
  for (let k = 0; k + 1 < runs.length; k++) {
    const a = runs[k].last;
    const b = runs[k + 1].first;
    const pts = [a, ...media.filter((t) => t > a && t < b), b];
    let best = 0;
    for (let i = 1; i + 1 < pts.length; i++) {
      if (pts[i + 1] - pts[i] > pts[best + 1] - pts[best]) best = i;
    }
    cuts.push((pts[best] + pts[best + 1]) / 2);
  }
  return cuts;
}

// The interpolated median, as percentile_cont(0.5) computes it.
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = (s.length - 1) / 2;
  return (s[Math.floor(m)] + s[Math.ceil(m)]) / 2;
}

// A place's suggestion, by the same rule the server applies to a whole card:
// the dominant geocoding cell's median point, its share of the donors, and
// the confidence those two give. Pure, so the split cards and the whole cards
// cannot disagree on what a suggestion is.
export function runSuggestion(donors: readonly UnplacedDonor[]): UnplacedSuggestion {
  const byCell = new Map<number | null, UnplacedDonor[]>();
  for (const d of donors) {
    const list = byCell.get(d.cell);
    if (list) list.push(d);
    else byCell.set(d.cell, [d]);
  }
  let dom: UnplacedDonor[] = [];
  for (const list of byCell.values()) if (list.length > dom.length) dom = list;
  const models = new Map<string, number>();
  for (const d of dom) if (d.model) models.set(d.model, (models.get(d.model) ?? 0) + 1);
  let model: string | null = null;
  for (const [m, n] of models) if (model == null || n > models.get(model)!) model = m;
  const share = donors.length ? dom.length / donors.length : 0;
  return {
    lat: median(dom.map((d) => d.lat)),
    lon: median(dom.map((d) => d.lon)),
    name: dom.find((d) => d.name)?.name ?? null,
    located: donors.length,
    share,
    confidence: suggestionConfidence(donors.length, share),
    window: "near",
    donor_model: model,
    evidence: null,
  };
}

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

// Confidence by DISTANCE (tight_km, docs/UNPLACED.md §12). `before` and
// `after` are the located frames nearest the card on each side — already
// within near_h, the caller asks no further — and `inside` the bounding box of
// the located frames inside its own hours. All of them within `tightM` of
// each other: bracketed (both sides) → high; one side, or inside only →
// medium. Anything wider, or nothing at all: null, and the cell-share rule
// stands. The pin is the side nearest in time — the frame 47 s before a clip,
// not the median of a cell the next town also falls in. Pure.
export function bracketEvidence(
  t0: number,
  t1: number,
  before: EvidenceFix | null,
  after: EvidenceFix | null,
  inside: { n: number; lat_min: number; lat_max: number; lon_min: number; lon_max: number } | null,
  tightM: number,
): { confidence: UnplacedConfidence; evidence: UnplacedEvidence; pin: EvidenceFix | null } | null {
  const pts: { lat: number; lon: number }[] = [];
  if (before) pts.push(before);
  if (after) pts.push(after);
  const n = inside?.n ?? 0;
  if (inside && n > 0) {
    pts.push({ lat: inside.lat_min, lon: inside.lon_min }, { lat: inside.lat_max, lon: inside.lon_max });
  }
  if (!pts.length) return null;
  // The diagonal of their bounding box: never less than the widest pair.
  const lat = pts.map((p) => p.lat);
  const lon = pts.map((p) => p.lon);
  const spread = distanceM(
    { lat: Math.min(...lat), lon: Math.min(...lon) },
    { lat: Math.max(...lat), lon: Math.max(...lon) },
  );
  if (spread > tightM) return null;
  const basis = before && after ? "bracketed" : before || after ? "one_side" : "inside";
  let pin: EvidenceFix | null = null;
  if (before && after) pin = t0 - Date.parse(before.at) <= Date.parse(after.at) - t1 ? before : after;
  else pin = before ?? after;
  return {
    confidence: basis === "bracketed" ? "high" : "medium",
    evidence: { basis, before, after, inside: n, spread_m: Math.round(spread) },
    pin,
  };
}

const RANK: Record<UnplacedConfidence, number> = { high: 0, medium: 1, low: 2 };

/** The better of two confidences — evidence never lowers what the share said. */
export function betterConfidence(a: UnplacedConfidence, b: UnplacedConfidence): UnplacedConfidence {
  return RANK[a] <= RANK[b] ? a : b;
}

/** Whether a card's suggestion is good enough to pre-fill the map — and
 *  the frames' own neighbours do not put them elsewhere. */
export function isReady(g: UnplacedGroup): boolean {
  return (
    g.kind !== "span" &&
    g.stops == null &&
    g.suggestion != null &&
    g.suggestion.confidence !== "low" &&
    g.neighbours?.agrees !== false
  );
}

/** A card best placed frame by frame (§13): not Ready, no stops of its own,
 *  no conflict, and the neighbours place at least half its frames. */
export function isNeighbourly(g: UnplacedGroup): boolean {
  const n = g.neighbours;
  return (
    !isReady(g) &&
    g.kind !== "span" &&
    g.stops == null &&
    g.conflict == null &&
    n != null &&
    n.placed > 0 &&
    n.placed * 2 >= n.total
  );
}

/** A card whose every unplaced media has no camera EXIF — screenshots, scans:
 * nothing there wants a position, and its one gesture is Exempt. */
export function isAllNoExif(g: UnplacedGroup): boolean {
  return g.unplaced > 0 && g.no_exif === g.unplaced;
}

// The order the backlog is worked in: what can be confirmed at a glance
// first (high, then medium), then what its frames' neighbours place, then
// what needs a look, then what needs a hand (no donor, or a span). Within a
// tier, the biggest pile first.
export function groupTier(g: UnplacedGroup): number {
  if (g.kind === "span") return 5;
  if (isNeighbourly(g)) return 2;
  const c = isReady(g) ? g.suggestion?.confidence : g.suggestion ? "low" : undefined;
  return c === "high" ? 0 : c === "medium" ? 1 : c === "low" ? 3 : 4;
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

// --- Follow a track (docs/UNPLACED.md §11) ----------------------------------
//
// A card's frames placed one by one from a TRACK: the fixes of an imported
// GPS track (kept since 0052) and/or the trustworthy located frames shot in
// the same hours (the phone in the pocket is a track too). Each frame lands
// where the track was at its own instant; consecutive frames that stay within
// split_km make a STOP, the unit the dialog lists and the human accepts.

/** One source a track can be made of, as the sources dialog lists it. */
export type TraceSource =
  | {
      kind: "import";
      id: number;
      name: string;
      import_kind: string;
      span_start: string;
      span_end: string;
      /** Fixes inside the card's window ± an hour. */
      points: number;
    }
  | {
      kind: "frames";
      /** camera_model, null for media that name none. */
      model: string | null;
      /** Located frames inside the window ± an hour. */
      points: number;
    };

/** One frame of the card, matched against the track. */
export type TraceFrame = {
  id: number;
  /** Capture instant, epoch ms. */
  at: number;
  /** Where the track was then, or null in a gap of it. */
  pos: { lat: number; lon: number } | null;
  /** 'track' when an imported track placed it (with that import), 'inferred'
   *  when other frames did — never 'manual', nothing was hand-placed. */
  source: "track" | "inferred" | null;
  import_id: number | null;
};

export type TraceStop = {
  index: number;
  /** "Pérols, France" from the nearest geocoded cell, else null. */
  name: string | null;
  lat: number;
  lon: number;
  /** The frames moved more than split_km inside the stop: a drive. */
  moving: boolean;
  /** Frame ids, in time order. */
  ids: number[];
  t0: number;
  t1: number;
};

export type TraceResponse = {
  stops: TraceStop[];
  /** Frames with no position from the track — they stay unplaced. */
  gaps: number[];
  /** The track itself, thinned, for the map's line. */
  line: { lat: number; lon: number }[];
  frames: TraceFrame[];
};

// Group a card's frames, in time order, into stops. A run of placed frames
// that stays within `splitM` of the frame that opened it is one place; a run
// that lasts less than `stayMs` is somewhere the photographer PASSED, not
// stayed — and passes that follow each other within `stayMs` join into one
// MOVING stop (a drive with the camera out), rather than a list of tiny stops
// along a road. A lone pass between two stays stays a stop of its own.
// Frames with no position are gaps. Pure.
export function traceStops(
  frames: readonly TraceFrame[],
  splitM: number,
  stayMs = 30 * 60_000,
): { runs: { frames: TraceFrame[]; moving: boolean }[]; gaps: number[] } {
  const sorted = [...frames].sort((a, b) => a.at - b.at || a.id - b.id);
  const gaps: number[] = [];
  const raw: TraceFrame[][] = [];
  for (const f of sorted) {
    if (!f.pos) {
      gaps.push(f.id);
      continue;
    }
    const cur = raw[raw.length - 1];
    if (cur && distanceM(cur[0].pos!, f.pos) <= splitM) cur.push(f);
    else raw.push([f]);
  }
  const span = (r: TraceFrame[]) => r[r.length - 1].at - r[0].at;
  const runs: { frames: TraceFrame[]; moving: boolean; pass: boolean }[] = [];
  for (const r of raw) {
    const pass = span(r) < stayMs;
    const prev = runs[runs.length - 1];
    const gap = prev ? r[0].at - prev.frames[prev.frames.length - 1].at : Infinity;
    if (pass && prev?.pass && gap <= stayMs) {
      prev.frames.push(...r);
      prev.moving = true;
    } else {
      runs.push({ frames: [...r], moving: false, pass });
    }
  }
  return { runs: runs.map(({ frames: f, moving }) => ({ frames: f, moving })), gaps };
}
