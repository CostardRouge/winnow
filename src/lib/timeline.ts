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

/** One uninterrupted run of shooting at one place, as SQL returns it. */
export type TimelineRun = {
  place: string | null;
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
  /** How many runs were folded in by absorption (0 = none). */
  absorbed: number;
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
): Promise<TimelineRun[]> {
  // Collapse RAW+JPEG pairs and burst piles to one logical medium, so a
  // chapter's count matches the grid it drills into (same call as the
  // calendar route).
  const { conditions, params } = buildFilter(filter, 1, {
    collapseGroups: true,
  });
  const where = conditions.join(" AND ");
  const place = PLACE_COLUMN[granularity];

  // The three rules are the same scan with a different break predicate, over
  // the `scoped` CTE (hence the `s.` prefixes):
  //   place  — a different place starts a chapter, whatever the delay.
  //   time   — a long enough silence starts a chapter, wherever we are.
  //   hybrid — a different place always does, and staying put only after three
  //            days: sleeping in a city must not end its chapter.
  // NULL place is its own value here (IS DISTINCT FROM), so a run of
  // ungeotagged media forms its own chapter instead of silently joining the
  // last known place — inferPlaces then decides, visibly, what to call it.
  const placeChanged = `s.place IS DISTINCT FROM lag(s.place) OVER w`;
  const silence = `s.captured_at - lag(s.captured_at) OVER w > $${params.length + 1} * interval '1 hour'`;

  // Only one bound is ever read, so the placeholder is always $n+1.
  const [breakExpr, bound] =
    mode === "place"
      ? [placeChanged, null]
      : mode === "time"
        ? [silence, gapHours]
        : [`${placeChanged} OR ${silence}`, SAME_PLACE_BREAK_HOURS];

  return many<TimelineRun>(
    `WITH scoped AS (
       SELECT a.id, a.captured_at, a.gps_lon, a.device, a.session_id,
              ${place} AS place
       FROM assets a
       LEFT JOIN ratings r ON r.asset_id = a.id
       WHERE ${where} AND a.captured_at IS NOT NULL
     ),
     marked AS (
       SELECT s.*, CASE WHEN ${breakExpr} THEN 1 ELSE 0 END AS brk
       FROM scoped s
       WINDOW w AS (ORDER BY s.captured_at, s.id)
     ),
     grouped AS (
       SELECT m.*, sum(m.brk) OVER (ORDER BY m.captured_at, m.id) AS run_id
       FROM marked m
     )
     SELECT
       max(g.place)                                        AS place,
       min(g.captured_at)                                  AS started_at,
       max(g.captured_at)                                  AS ended_at,
       count(*)::int                                       AS count,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY g.gps_lon) AS median_lon,
       count(g.gps_lon)::int                               AS geotagged,
       array_remove(array_agg(DISTINCT g.device), NULL)    AS devices,
       -- The folders this run crosses, id + name: the chapter shows them as
       -- links, because "these three directories are one stay" is the whole
       -- point of the view.
       (SELECT json_agg(json_build_object('id', x.id, 'name', x.name) ORDER BY x.name)
          FROM (SELECT DISTINCT s.id, s.name) x)           AS sessions
     FROM grouped g
     JOIN sessions s ON s.id = g.session_id
     GROUP BY g.run_id
     ORDER BY min(g.captured_at)`,
    bound == null ? params : [...params, bound],
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
export function absorbRuns(
  runs: TimelineRun[],
  absorbMin: number,
): { runs: TimelineRun[]; absorbed: number }[] {
  const groups: { runs: TimelineRun[]; absorbed: number }[] = runs.map((r) => ({
    runs: [r],
    absorbed: 0,
  }));
  if (absorbMin <= 0) return groups;

  const total = (g: { runs: TimelineRun[] }) =>
    g.runs.reduce((n, r) => n + r.count, 0);

  // Repeat until nothing moves: absorbing a crumb can leave its neighbour
  // still under the threshold, and a single pass would stop halfway. Bounded
  // by the run count — every iteration removes exactly one group.
  for (let guard = 0; guard < runs.length; guard++) {
    const idx = groups.findIndex(
      (g, k) =>
        total(g) < absorbMin &&
        ((k > 0 && gapHoursBetween(groups[k - 1].runs, g.runs) <= ABSORB_MAX_GAP_HOURS) ||
          (k < groups.length - 1 &&
            gapHoursBetween(g.runs, groups[k + 1].runs) <= ABSORB_MAX_GAP_HOURS)),
    );
    if (idx < 0) break;

    const before =
      idx > 0 ? gapHoursBetween(groups[idx - 1].runs, groups[idx].runs) : Infinity;
    const after =
      idx < groups.length - 1
        ? gapHoursBetween(groups[idx].runs, groups[idx + 1].runs)
        : Infinity;
    // Merge toward the nearer neighbour; ties go backwards so the chapter keeps
    // the earlier start (a chapter is named by where it began).
    const target = before <= after ? idx - 1 : idx + 1;
    const [lo, hi] = target < idx ? [target, idx] : [idx, target];
    groups.splice(lo, 2, {
      runs: [...groups[lo].runs, ...groups[hi].runs],
      absorbed: groups[lo].absorbed + groups[hi].absorbed + 1,
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

function assemble(
  group: { runs: TimelineRun[]; absorbed: number },
): TimelineChapter {
  const { runs, absorbed } = group;
  // The chapter is named by its dominant place — the one holding the most
  // media, not simply the first, so a stop-off never names the whole day.
  const tally = new Map<string, number>();
  for (const r of runs) if (r.place) tally.set(r.place, (tally.get(r.place) ?? 0) + r.count);
  const places = [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);

  const geotagged = runs.reduce((n, r) => n + r.geotagged, 0);
  // Median of the run medians, weighted by nothing: at chapter scale the runs
  // are all within a few dozen kilometres, so the middle one is representative.
  const lons = runs.map((r) => r.median_lon).filter((l): l is number => l != null).sort((a, b) => a - b);

  const started_at = runs[0].started_at;
  return {
    key: started_at,
    name: places[0] ?? "Lieu inconnu",
    started_at,
    ended_at: runs[runs.length - 1].ended_at,
    count: runs.reduce((n, r) => n + r.count, 0),
    places,
    devices: [...new Set(runs.flatMap((r) => r.devices))],
    sessions: [...new Map(runs.flatMap((r) => r.sessions).map((s) => [s.id, s])).values()],
    tz_offset_hours: tzOffsetFromLongitude(lons.length ? lons[lons.length >> 1] : null),
    place_inferred: geotagged === 0,
    absorbed,
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
): Promise<{ granularity: PlaceGranularity; runs: TimelineRun[] }> {
  if (opts.granularity !== "auto") {
    return {
      granularity: opts.granularity,
      runs: await fetchRuns(filter, opts.granularity, opts.mode, opts.gapHours),
    };
  }
  const order: PlaceGranularity[] = ["region", "county", "city"];
  let last: { granularity: PlaceGranularity; runs: TimelineRun[] } | null = null;
  for (const granularity of order) {
    const runs = await fetchRuns(filter, granularity, opts.mode, opts.gapHours);
    const n = absorbRuns(runs, opts.mode === "hybrid" ? opts.absorbMin : 0).length;
    last = { granularity, runs };
    if (n >= GRAN_MIN_CHAPTERS && n <= GRAN_MAX_CHAPTERS) return last;
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
    `SELECT b.idx, COALESCE(array_agg(p.id ORDER BY p.captured_at), '{}') AS ids
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
  const { granularity, runs } = await pickGranularity(filter, opts);
  const groups = absorbRuns(runs, opts.mode === "hybrid" ? opts.absorbMin : 0);
  const bare = inferPlaces(groups.map(assemble));
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
