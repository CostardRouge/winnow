// Timeline — the chronological reading of the library, cut into CHAPTERS.
//
// The gallery already answers "what did I shoot that day" (the Calendar) and
// "where" (the Map). Neither tells the story of a period: a year in Australia
// lands in dozens of session folders, and a session is a DIRECTORY ON DISK
// (cf. docs/memory/pipeline.md), never a leg of a trip. A chapter is the unit
// that crosses those folders — "Sydney, 3 → 11 March" — derived from capture
// time + reverse-geocoded place, never stored.
//
// Derivation runs in three passes so the heavy one stays in Postgres:
//   1. SQL: one ordered scan with LAG + a running sum of breaks, aggregated to
//      ONE ROW PER RUN. A 100k library collapses to a few hundred rows here —
//      the browser and this module never see the assets themselves.
//   2. JS (pure, below): absorb the crumbs a place change carves out of a
//      driving day. Operating on runs, not assets, is what makes this cheap.
//   3. SQL: one cover per resolved chapter, preferring a ready derivative —
//      the same DISTINCT ON shape api/assets/calendar uses.
//
// Chapters are DERIVED, so re-deriving must always be safe: what a human edits
// (a name, a forced split, a forced merge) is stored as a CORRECTION to the
// derivation, never as a copy of the chapters — the same reasoning bursts use
// ("ratings stay per-asset, so re-clustering is safe", migration 0029).
import { many } from "./db";
import { buildFilter, type PartialAssetFilter } from "./filter";

/** Which place column names a chapter. `place_region` is state OR région — the
 *  same column carries "New South Wales" and "Occitanie" (migration 0020). */
export type PlaceGranularity = "city" | "county" | "region";
export const GRANULARITIES: PlaceGranularity[] = ["city", "county", "region"];

const PLACE_COLUMN: Record<PlaceGranularity, string> = {
  city: "a.place_city",
  county: "a.place_county",
  region: "a.place_region",
};

export type ChapterMode = "place" | "time" | "hybrid";

export type TimelineOptions = {
  mode: ChapterMode;
  /** "auto" lets pickGranularity choose and report what it picked. */
  granularity: PlaceGranularity | "auto";
  /** Time-first: break past this many hours of silence. */
  gapHours: number;
  /** Hybrid: absorb a run holding fewer than this many media. 0 disables. */
  absorbMin: number;
};

export const TIMELINE_DEFAULTS: TimelineOptions = {
  mode: "hybrid",
  granularity: "auto",
  gapHours: 8,
  absorbMin: 40,
};

// Hybrid only: staying in one place must not break the chapter just because we
// slept there, so a same-place gap has to be genuinely long to count. Three
// days is "we left and came back", not "it was night".
const SAME_PLACE_BREAK_HOURS = 72;
// A crumb only merges into a neighbour that belongs to the same run of
// shooting; past this the two are separate outings and the crumb stands alone.
const ABSORB_MAX_GAP_HOURS = 6;

/** One uninterrupted run of shooting, as SQL returns it.
 *
 *  Under the `place` rule a run holds exactly one place, but under `time` it
 *  can cross several (a day driving through six villages is one run), so the
 *  run carries the whole DISTRIBUTION, busiest first. Collapsing it to a
 *  single value here would name that day after whichever place sorted last. */
export type TimelineRun = {
  places: { place: string | null; n: number }[];
  started_at: string;
  ended_at: string;
  count: number;
  /** Median longitude of the run's geotagged media — the local-day offset. */
  median_lon: number | null;
  geotagged: number;
  devices: string[];
  sessions: { id: number; name: string }[];
};

export type TimelineChapter = {
  /** Stable across a request: the ISO start, which is also the URL key. */
  key: string;
  name: string;
  started_at: string;
  ended_at: string;
  count: number;
  /** Distinct places the chapter spans, most-media-first. */
  places: string[];
  devices: string[];
  sessions: { id: number; name: string }[];
  /** Hours to add to UTC to read this chapter's days as they were lived. */
  tz_offset_hours: number | null;
  /** True when no media in the chapter carries GPS: the place, if any, was
   *  inferred from the neighbouring chapters rather than measured. Never a
   *  reason to write anything — cf. inferPlaces below. */
  place_inferred: boolean;
  /** How many of the chapter's media carry no position at all — what a
   *  human-chosen location can offer to place, through the geotag recap. */
  ungeotagged: number;
  /** How many runs were folded in by absorption (0 = none). */
  absorbed: number;
  /** The named span (timeline_chapters row) this chapter is pinned to, if a
   *  human renamed / merged / located it. NULL = purely derived. */
  override_id: number | null;
  /** Human-chosen location of the chapter (from its span). Display only —
   *  never copied onto the media by the derivation. */
  place_label: string | null;
  place_lat: number | null;
  place_lon: number | null;
  /** The forced split (timeline_breaks row) that starts this chapter, if one
   *  does — deleting it re-glues the chapter to the previous one. */
  break_id: number | null;
  cover_id: number | null;
  /** A handful of ids spread evenly across the chapter's span — the collapsed
   *  row tells the arc of the stay, not its first hour. */
  sample_ids: number[];
};

// How many tiles a collapsed chapter shows. The row is a sample, not a page:
// enough to read the shape of a stay, few enough that thirty chapters stay one
// cheap request each.
const SAMPLE_SIZE = 10;

/* ---------------------------------------------------------------------------
   Corrections — what a human stored on top of the derivation
   --------------------------------------------------------------------------- */

/** A named span (timeline_chapters): everything captured inside is one chapter,
 *  carrying this name and location. Its bounds also act as forced breaks. */
export type ChapterSpan = {
  id: number;
  starts_at: string;
  ends_at: string;
  name: string | null;
  place_label: string | null;
  place_lat: number | null;
  place_lon: number | null;
};

/** A forced split (timeline_breaks): media at or after `at` start a chapter. */
export type ChapterBreak = { id: number; at: string };

export type ChapterOverrides = { spans: ChapterSpan[]; breaks: ChapterBreak[] };

/** Both correction tables, whole — counted in tens (cf. migration 0040). */
export async function fetchOverrides(): Promise<ChapterOverrides> {
  const [spans, breaks] = await Promise.all([
    many<ChapterSpan>(
      `SELECT id, starts_at, ends_at, name, place_label, place_lat, place_lon
       FROM timeline_chapters ORDER BY starts_at`,
    ),
    many<ChapterBreak>(`SELECT id, at FROM timeline_breaks ORDER BY at`),
  ]);
  return { spans, breaks };
}

/** Every instant the scan must break at: the explicit splits, plus both edges
 *  of every named span so a derived run never straddles one. The end edge is
 *  one second past the span's last frame — a break at exactly `ends_at` would
 *  cut that frame off its own span. */
export function forcedBreaks(ov: ChapterOverrides): string[] {
  const edges = ov.spans.flatMap((s) => [
    s.starts_at,
    new Date(Date.parse(s.ends_at) + 1000).toISOString(),
  ]);
  return [...ov.breaks.map((b) => b.at), ...edges];
}

/* ---------------------------------------------------------------------------
   Pass 1 — the SQL scan
   --------------------------------------------------------------------------- */

/**
 * One row per run of consecutive media sharing a place, over the filtered set.
 *
 * The break predicate lives in SQL because it needs LAG over the whole ordered
 * set; the running `sum(break)` turns it into a group key. Undated media are
 * excluded outright: a chapter with no time cannot be placed on a timeline
 * (they stay reachable through the grid, which does not order by time).
 */
export async function fetchRuns(
  filter: PartialAssetFilter,
  granularity: PlaceGranularity,
  mode: ChapterMode,
  gapHours: number,
  /** Instants that always start a new run (cf. forcedBreaks). */
  breaks: string[] = [],
): Promise<TimelineRun[]> {
  // Collapse RAW+JPEG pairs and burst piles to one logical medium, so a
  // chapter's count matches the grid it drills into (same call as the
  // calendar route).
  const { conditions, params } = buildFilter(filter, 1, {
    collapseGroups: true,
  });
  const where = conditions.join(" AND ");
  const place = PLACE_COLUMN[granularity];

  // The three rules are the same scan with a different break predicate, read
  // off the `lagged` CTE (hence the `l.` prefixes, and prev_at / prev_place):
  //   place  — a different place starts a chapter, whatever the delay.
  //   time   — a long enough silence starts a chapter, wherever we are.
  //   hybrid — a different place always does, and staying put only after three
  //            days: sleeping in a city must not end its chapter.
  // NULL place is its own value here (IS DISTINCT FROM), so a run of
  // ungeotagged media forms its own chapter instead of silently joining the
  // last known place — inferPlaces then decides, visibly, what to call it.
  // On top of the rule, a forced break (a human split, or a named span's
  // edge) that falls in (prev_at, captured_at] always starts a run.
  const placeChanged = `l.place IS DISTINCT FROM l.prev_place`;
  const boundIdx = params.length + 1;
  const silence = `l.captured_at - l.prev_at > $${boundIdx} * interval '1 hour'`;

  const [breakExpr, bound] =
    mode === "place"
      ? [placeChanged, null]
      : mode === "time"
        ? [silence, gapHours]
        : [`${placeChanged} OR ${silence}`, SAME_PLACE_BREAK_HOURS];
  const breaksIdx = bound == null ? boundIdx : boundIdx + 1;

  return many<TimelineRun>(
    `WITH scoped AS (
       SELECT a.id, a.captured_at, a.gps_lon, a.device, a.session_id,
              ${place} AS place
       FROM assets a
       LEFT JOIN ratings r ON r.asset_id = a.id
       WHERE ${where} AND a.captured_at IS NOT NULL
     ),
     lagged AS (
       SELECT s.*,
              lag(s.captured_at) OVER w AS prev_at,
              lag(s.place)       OVER w AS prev_place
       FROM scoped s
       WINDOW w AS (ORDER BY s.captured_at, s.id)
     ),
     marked AS (
       SELECT l.*,
              CASE
                WHEN l.prev_at IS NULL THEN 0
                WHEN ${breakExpr} THEN 1
                WHEN EXISTS (SELECT 1 FROM unnest($${breaksIdx}::timestamptz[]) fb
                              WHERE fb > l.prev_at AND fb <= l.captured_at) THEN 1
                ELSE 0
              END AS brk
       FROM lagged l
     ),
     grouped AS (
       SELECT m.*, sum(m.brk) OVER (ORDER BY m.captured_at, m.id) AS run_id
       FROM marked m
     ),
     -- Two-level aggregation: per (run, place) first, then rolled up into one
     -- ordered list per run. A scalar subquery over the outer group cannot see
     -- ungrouped columns, so the histogram has to be built this way round.
     per_place AS (
       SELECT run_id, place, count(*)::int AS n
       FROM grouped GROUP BY run_id, place
     ),
     place_lists AS (
       SELECT run_id,
              jsonb_agg(jsonb_build_object('place', place, 'n', n)
                        ORDER BY n DESC, place) AS places
       FROM per_place GROUP BY run_id
     ),
     runs AS (
       SELECT
         g.run_id                                            AS run_id,
         min(g.captured_at)                                  AS started_at,
         max(g.captured_at)                                  AS ended_at,
         count(*)::int                                       AS count,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY g.gps_lon) AS median_lon,
         count(g.gps_lon)::int                               AS geotagged,
         array_remove(array_agg(DISTINCT g.device), NULL)    AS devices,
         -- The folders this run crosses, id + name: the chapter shows them as
         -- links, because "these three directories are one stay" is the whole
         -- point of the view. jsonb, not json: only jsonb has an equality
         -- operator, so only jsonb_agg can take DISTINCT. Ordering is left to
         -- the caller — DISTINCT forbids an ORDER BY that isn't the argument.
         jsonb_agg(DISTINCT jsonb_build_object('id', s.id, 'name', s.name))
                                                             AS sessions
       FROM grouped g
       JOIN sessions s ON s.id = g.session_id
       GROUP BY g.run_id
     )
     SELECT r.started_at, r.ended_at, r.count, r.median_lon, r.geotagged,
            r.devices, r.sessions, pl.places
     FROM runs r JOIN place_lists pl ON pl.run_id = r.run_id
     ORDER BY r.started_at`,
    bound == null ? [...params, breaks] : [...params, bound, breaks],
  );
}

/* ---------------------------------------------------------------------------
   Pass 2 — absorption (pure, over a few hundred runs)
   --------------------------------------------------------------------------- */

const HOUR_MS = 3_600_000;
const gapHoursBetween = (a: TimelineRun[], b: TimelineRun[]) =>
  (Date.parse(b[0].started_at) - Date.parse(a[a.length - 1].ended_at)) / HOUR_MS;

/**
 * Fold the crumbs a place change carves out of a day on the road.
 *
 * Driving the Great Ocean Road crosses six villages in one day: place-first
 * cutting turns that into six chapters, four of them under forty frames. A
 * crumb merges into whichever adjacent run is closer in time, but only while
 * they still belong to the same outing (ABSORB_MAX_GAP_HOURS) — otherwise a
 * lone evening shot would glue two unrelated days together.
 *
 * Pure and total: exported bare because it is the one piece of this feature
 * worth testing on its own the day the repo grows a test runner
 * (docs/ARCHITECTURE-REVIEW.md §3.5).
 */
export type RunGroup = {
  runs: TimelineRun[];
  absorbed: number;
  /** The named span that owns this group, if any. A pinned group neither
   *  absorbs nor gets absorbed: the human drew its edges. */
  span: ChapterSpan | null;
};

/**
 * Fold every run captured inside a named span into one pinned group. Runs are
 * already cut at span edges by the SQL scan (cf. forcedBreaks), so membership
 * is a plain containment test and consecutive members merge.
 */
export function applySpans(runs: TimelineRun[], spans: ChapterSpan[]): RunGroup[] {
  const owner = (r: TimelineRun) =>
    spans.find((s) => r.started_at >= s.starts_at && r.ended_at <= s.ends_at) ?? null;
  const groups: RunGroup[] = [];
  for (const r of runs) {
    const span = owner(r);
    const last = groups[groups.length - 1];
    if (span && last && last.span === span) last.runs.push(r);
    else groups.push({ runs: [r], absorbed: 0, span });
  }
  return groups;
}

export function absorbRuns(groupsIn: RunGroup[], absorbMin: number): RunGroup[] {
  const groups = groupsIn.map((g) => ({ ...g, runs: [...g.runs] }));
  if (absorbMin <= 0) return groups;

  const total = (g: RunGroup) => g.runs.reduce((n, r) => n + r.count, 0);
  const near = (a: RunGroup, b: RunGroup) =>
    gapHoursBetween(a.runs, b.runs) <= ABSORB_MAX_GAP_HOURS;
  // A crumb can only move into a free (unpinned) neighbour, and a pinned
  // crumb stays where the human put it.
  const free = (g: RunGroup | undefined) => !!g && !g.span;

  // Repeat until nothing moves: absorbing a crumb can leave its neighbour
  // still under the threshold, and a single pass would stop halfway. Bounded
  // by the group count — every iteration removes exactly one group.
  for (let guard = 0; guard < groupsIn.length; guard++) {
    const idx = groups.findIndex(
      (g, k) =>
        free(g) &&
        total(g) < absorbMin &&
        ((free(groups[k - 1]) && near(groups[k - 1], g)) ||
          (free(groups[k + 1]) && near(g, groups[k + 1]))),
    );
    if (idx < 0) break;

    const before = free(groups[idx - 1])
      ? gapHoursBetween(groups[idx - 1].runs, groups[idx].runs)
      : Infinity;
    const after = free(groups[idx + 1])
      ? gapHoursBetween(groups[idx].runs, groups[idx + 1].runs)
      : Infinity;
    // Merge toward the nearer neighbour; ties go backwards so the chapter keeps
    // the earlier start (a chapter is named by where it began).
    const target = before <= after ? idx - 1 : idx + 1;
    const [lo, hi] = target < idx ? [target, idx] : [idx, target];
    groups.splice(lo, 2, {
      runs: [...groups[lo].runs, ...groups[hi].runs],
      absorbed: groups[lo].absorbed + groups[hi].absorbed + 1,
      span: null,
    });
  }
  return groups;
}

/* ---------------------------------------------------------------------------
   Chapter assembly
   --------------------------------------------------------------------------- */

/** Hours to add to UTC so a chapter's days read as they were lived.
 *
 *  capture_date and capture_year/month/day are materialized AT UTC by the
 *  trigger of migration 0003, and NO timezone column exists anywhere in the
 *  schema. In France the one-hour skew is invisible; in Australia (+11) every
 *  frame shot before 11:00 local is filed under the PREVIOUS day — which is
 *  exactly the sunrises. A chapter already carries a place, hence a longitude,
 *  and 15° of longitude is one hour: enough to put the day boundaries back
 *  where the photographer stood. Deliberately approximate — it ignores DST and
 *  the political shape of real timezones — so the UI always states the offset
 *  it used rather than silently showing a different day. */
export function tzOffsetFromLongitude(lon: number | null): number | null {
  if (lon == null || !Number.isFinite(lon)) return null;
  return Math.round(lon / 15);
}

function assemble(group: RunGroup): TimelineChapter {
  const { runs, absorbed, span } = group;
  // The chapter is named by its dominant place — the one holding the most
  // media across every run it spans, not the first or the last. Under the
  // time rule one run already crosses several places, which is why the run
  // carries a distribution rather than a single value.
  const tally = new Map<string, number>();
  for (const r of runs) {
    for (const { place, n } of r.places ?? []) {
      if (place) tally.set(place, (tally.get(place) ?? 0) + n);
    }
  }
  const places = [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);

  const geotagged = runs.reduce((n, r) => n + r.geotagged, 0);
  // Median of the run medians, weighted by nothing: at chapter scale the runs
  // are all within a few dozen kilometres, so the middle one is representative.
  const lons = runs.map((r) => r.median_lon).filter((l): l is number => l != null).sort((a, b) => a - b);

  const started_at = runs[0].started_at;
  // A human-located chapter reads its days at that location's longitude:
  // the point of choosing a place is that the media had none.
  const lon = span?.place_lon ?? (lons.length ? lons[lons.length >> 1] : null);
  return {
    key: started_at,
    name: span?.name ?? places[0] ?? "Lieu inconnu",
    started_at,
    ended_at: runs[runs.length - 1].ended_at,
    count: runs.reduce((n, r) => n + r.count, 0),
    places,
    devices: [...new Set(runs.flatMap((r) => r.devices))],
    sessions: [...new Map(runs.flatMap((r) => r.sessions ?? []).map((s) => [s.id, s])).values()].sort(
      (a, b) => a.name.localeCompare(b.name),
    ),
    tz_offset_hours: tzOffsetFromLongitude(lon),
    // A chosen location is not an inference — the doubt has been resolved by
    // the human who chose it.
    place_inferred: geotagged === 0 && span?.place_label == null,
    ungeotagged: runs.reduce((n, r) => n + r.count, 0) - geotagged,
    absorbed,
    override_id: span?.id ?? null,
    place_label: span?.place_label ?? null,
    place_lat: span?.place_lat ?? null,
    place_lon: span?.place_lon ?? null,
    break_id: null,
    cover_id: null,
    sample_ids: [],
  };
}

/**
 * Name the chapters that hold no GPS at all from their neighbours in time.
 *
 * A drone flight indoors, a scan, an old import: the media are real and dated
 * but carry no fix, so geocoding never gave them a place. Sitting between two
 * chapters that agree on where we were, the honest reading is that they belong
 * there too — and the honest presentation is to SAY it was inferred.
 *
 * This is display only, and deliberately so. `POST /api/assets/geotag` writes
 * coordinates back into the ORIGINAL file's EXIF (queue `gpswrite`,
 * lib/exifWrite.ts) — the one sanctioned exception to "originals are read
 * once", and it is sanctioned because a human confirmed a before/after recap.
 * A guess is not that confirmation, so nothing here touches an asset row, arms
 * gps_write_status, or enqueues anything. Confirming an inferred place is a
 * separate, explicit gesture that goes through the existing geotag flow.
 */
export function inferPlaces(chapters: TimelineChapter[]): TimelineChapter[] {
  return chapters.map((ch, k) => {
    if (!ch.place_inferred || ch.places.length) return ch;
    const prev = chapters[k - 1];
    const next = chapters[k + 1];
    // Only when both sides agree, or only one side exists: a chapter wedged
    // between two different places is genuinely unknown, and guessing which
    // one it belongs to would be worse than saying nothing.
    const from =
      prev?.places[0] && next?.places[0]
        ? prev.places[0] === next.places[0]
          ? prev.places[0]
          : null
        : (prev?.places[0] ?? next?.places[0] ?? null);
    if (!from) return ch;
    return {
      ...ch,
      name: from,
      places: [from],
      tz_offset_hours: ch.tz_offset_hours ?? prev?.tz_offset_hours ?? next?.tz_offset_hours ?? null,
    };
  });
}

/* ---------------------------------------------------------------------------
   Granularity
   --------------------------------------------------------------------------- */

// What "readable" means for a stream of chapters: fewer than this and the page
// says nothing (three chapters for a year of travel), more and it is the
// session list again with different words.
const GRAN_MIN_CHAPTERS = 6;
const GRAN_MAX_CHAPTERS = 30;

/**
 * Pick the place granularity that cuts the current selection into a readable
 * number of chapters, coarsest first.
 *
 * Region → County → City: a year abroad reads best by state, a weekend at home
 * by city, and the same rule serves both without the user having to think
 * about which column exists. Stops at the first level clearing the minimum and
 * still under the ceiling; if none does, keeps the last level tried (city),
 * because too many chapters is recoverable by filtering and too few is not.
 *
 * The chosen level is returned so the UI can name it — an automatic cut that
 * cannot be seen or pinned is an automatic cut nobody trusts.
 */
export async function pickGranularity(
  filter: PartialAssetFilter,
  opts: TimelineOptions,
  ov: ChapterOverrides,
): Promise<{ granularity: PlaceGranularity; groups: RunGroup[] }> {
  const breaks = forcedBreaks(ov);
  const cut = async (granularity: PlaceGranularity) => {
    const runs = await fetchRuns(filter, granularity, opts.mode, opts.gapHours, breaks);
    return absorbRuns(applySpans(runs, ov.spans), opts.mode === "hybrid" ? opts.absorbMin : 0);
  };
  if (opts.granularity !== "auto") {
    return { granularity: opts.granularity, groups: await cut(opts.granularity) };
  }
  const order: PlaceGranularity[] = ["region", "county", "city"];
  let last: { granularity: PlaceGranularity; groups: RunGroup[] } | null = null;
  for (const granularity of order) {
    const groups = await cut(granularity);
    last = { granularity, groups };
    if (groups.length >= GRAN_MIN_CHAPTERS && groups.length <= GRAN_MAX_CHAPTERS) return last;
  }
  return last!;
}

/* ---------------------------------------------------------------------------
   Pass 3 — covers
   --------------------------------------------------------------------------- */

/**
 * One cover per chapter: a ready derivative first (so a thumbnail exists), then
 * a kept frame, then the sharpest — the nudge toward the shot that represents
 * the chapter rather than the one that happens to be first.
 *
 * Bounded by construction: one LATERAL per chapter over the (captured_at, id)
 * index, and chapters are counted in tens.
 */
export async function attachCovers(
  filter: PartialAssetFilter,
  chapters: TimelineChapter[],
): Promise<TimelineChapter[]> {
  if (!chapters.length) return chapters;
  const { conditions, params } = buildFilter(filter, 1, { collapseGroups: true });
  const where = conditions.join(" AND ");
  const i = params.length;

  const rows = await many<{ idx: number; cover_id: number }>(
    `SELECT b.idx, cov.id AS cover_id
     FROM unnest($${i + 1}::timestamptz[], $${i + 2}::timestamptz[])
          WITH ORDINALITY AS b(lo, hi, idx)
     CROSS JOIN LATERAL (
       SELECT a.id
       FROM assets a
       LEFT JOIN ratings r ON r.asset_id = a.id
       WHERE ${where} AND a.captured_at >= b.lo AND a.captured_at <= b.hi
       ORDER BY (a.derivative_status = 'ready') DESC,
                (r.verdict = 'pick') DESC,
                a.sharpness DESC NULLS LAST,
                a.captured_at ASC
       LIMIT 1
     ) cov`,
    [...params, chapters.map((c) => c.started_at), chapters.map((c) => c.ended_at)],
  );

  const byIdx = new Map(rows.map((r) => [r.idx, r.cover_id]));
  return chapters.map((c, k) => ({ ...c, cover_id: byIdx.get(k + 1) ?? null }));
}

/**
 * The collapsed row of a chapter: SAMPLE_SIZE ids spread evenly over its
 * time span, one per bucket, each bucket's best frame by the same preference
 * as the cover. Showing the first N frames instead would make every chapter
 * look like its first hour; a spread reads as the arc of the stay.
 *
 * The client then fetches those ids through /api/assets?ids= — the shared
 * GRID_SELECT projection — so the tiles, badges, ratings and the viewer are the
 * gallery's own, not a second implementation.
 */
export async function attachSamples(
  filter: PartialAssetFilter,
  chapters: TimelineChapter[],
): Promise<TimelineChapter[]> {
  if (!chapters.length) return chapters;
  const { conditions, params } = buildFilter(filter, 1, { collapseGroups: true });
  const where = conditions.join(" AND ");
  const i = params.length;

  const rows = await many<{ idx: number; ids: number[] }>(
    `SELECT b.idx, array_remove(array_agg(p.id ORDER BY p.captured_at), NULL) AS ids
     FROM unnest($${i + 1}::timestamptz[], $${i + 2}::timestamptz[])
          WITH ORDINALITY AS b(lo, hi, idx)
     LEFT JOIN LATERAL (
       SELECT DISTINCT ON (bucket) sub.id, sub.captured_at
       FROM (
         SELECT a.id, a.captured_at, a.derivative_status, a.sharpness, r.verdict,
                -- +1 second on the upper bound so the last frame falls inside
                -- the final bucket instead of one past it.
                width_bucket(extract(epoch FROM a.captured_at),
                             extract(epoch FROM b.lo),
                             extract(epoch FROM b.hi) + 1,
                             $${i + 3}::int) AS bucket
         FROM assets a
         LEFT JOIN ratings r ON r.asset_id = a.id
         WHERE ${where} AND a.captured_at >= b.lo AND a.captured_at <= b.hi
       ) sub
       ORDER BY bucket,
                (sub.derivative_status = 'ready') DESC,
                (sub.verdict = 'pick') DESC,
                sub.sharpness DESC NULLS LAST,
                sub.captured_at ASC
     ) p ON true
     GROUP BY b.idx`,
    [
      ...params,
      chapters.map((c) => c.started_at),
      chapters.map((c) => c.ended_at),
      SAMPLE_SIZE,
    ],
  );

  const byIdx = new Map(rows.map((r) => [r.idx, r.ids.filter((x) => x != null)]));
  return chapters.map((c, k) => ({ ...c, sample_ids: byIdx.get(k + 1) ?? [] }));
}

/* ---------------------------------------------------------------------------
   The whole derivation
   --------------------------------------------------------------------------- */

/** Tell each chapter which forced split, if any, is the reason it starts: the
 *  break sitting in (previous chapter's end, this chapter's start]. That is
 *  the split's undo handle — deleting it re-glues the two. */
function attachBreaks(chapters: TimelineChapter[], breaks: ChapterBreak[]): TimelineChapter[] {
  return chapters.map((ch, k) => {
    const prevEnd = chapters[k - 1]?.ended_at ?? null;
    const b = breaks.find(
      (x) => x.at <= ch.started_at && (prevEnd == null || x.at > prevEnd),
    );
    return { ...ch, break_id: b?.id ?? null };
  });
}

export type TimelineResult = {
  chapters: TimelineChapter[];
  granularity: PlaceGranularity;
  /** Whether `granularity` was chosen for the user or asked for. */
  granularity_auto: boolean;
};

export async function deriveTimeline(
  filter: PartialAssetFilter,
  opts: TimelineOptions,
): Promise<TimelineResult> {
  const ov = await fetchOverrides();
  const { granularity, groups } = await pickGranularity(filter, opts, ov);
  const bare = attachBreaks(inferPlaces(groups.map(assemble)), ov.breaks);
  // Covers and samples are independent per-chapter lookups: run them side by
  // side and merge, rather than paying two round trips in sequence.
  const [withCovers, withSamples] = await Promise.all([
    attachCovers(filter, bare),
    attachSamples(filter, bare),
  ]);
  const chapters = withCovers.map((c, k) => ({ ...c, sample_ids: withSamples[k].sample_ids }));
  return { chapters, granularity, granularity_auto: opts.granularity === "auto" };
}

/** Per-month totals for the chronological spine, over the whole filtered set
 *  (not the visible window) — what makes a year of travel reachable in one
 *  gesture, the way `bounds` does for the calendar. */
export async function fetchSpine(
  filter: PartialAssetFilter,
): Promise<{ year: number; month: number; count: number }[]> {
  const { conditions, params } = buildFilter(filter, 1, { collapseGroups: true });
  return many<{ year: number; month: number; count: number }>(
    `SELECT a.capture_year AS year, a.capture_month AS month, count(*)::int AS count
     FROM assets a
     LEFT JOIN ratings r ON r.asset_id = a.id
     WHERE ${conditions.join(" AND ")} AND a.capture_year IS NOT NULL
     GROUP BY a.capture_year, a.capture_month
     ORDER BY a.capture_year, a.capture_month`,
    params,
  );
}
