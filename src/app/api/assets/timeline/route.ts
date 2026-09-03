// GET /api/assets/timeline ?<cumulative filters>
//     &mode=place|time|hybrid &gran=auto|city|county|region &gap=<hours>
//     &absorb=<media>
// → the library read as a story: chapters (a stay in a place, spanning as many
// session folders as it needs), plus the per-month spine the UI scrubs with.
//
// Chapters are DERIVED on every request, never stored — see lib/timeline.ts for
// why, and for the three passes that keep a 100k library affordable (the heavy
// scan stays in Postgres and returns one row per run, not per asset).
//
// `granularity` comes back in the payload because the default picks a level for
// the user: a cut nobody can see or pin is a cut nobody trusts.
import { NextRequest } from "next/server";
import { many } from "@/lib/db";
import { buildFilter, filterFromSearchParams } from "@/lib/filter";
import {
  deriveTimeline,
  fetchSpine,
  GRANULARITIES,
  TIMELINE_DEFAULTS,
  type ChapterMode,
  type PlaceGranularity,
  type TimelineOptions,
} from "@/lib/timeline";
import { json, badRequest, serverError } from "@/lib/api";

// DB-backed route: never pre-rendered/cached at build time.
export const dynamic = "force-dynamic";

const MODES: ChapterMode[] = ["place", "time", "hybrid"];

function num(raw: string | null, fallback: number, lo: number, hi: number) {
  const n = Number.parseFloat(raw ?? "");
  return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : fallback;
}

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    let filter;
    try {
      filter = filterFromSearchParams(sp);
    } catch (e) {
      return badRequest("Invalid filter", (e as Error).message);
    }

    const rawMode = sp.get("mode");
    const rawGran = sp.get("gran");
    if (rawMode && !MODES.includes(rawMode as ChapterMode))
      return badRequest(`mode must be one of ${MODES.join(", ")}`);
    if (rawGran && rawGran !== "auto" && !GRANULARITIES.includes(rawGran as PlaceGranularity))
      return badRequest(`gran must be auto or one of ${GRANULARITIES.join(", ")}`);

    const opts: TimelineOptions = {
      mode: (rawMode as ChapterMode) ?? TIMELINE_DEFAULTS.mode,
      granularity: (rawGran as PlaceGranularity | "auto") ?? TIMELINE_DEFAULTS.granularity,
      gapHours: num(sp.get("gap"), TIMELINE_DEFAULTS.gapHours, 1, 168),
      absorbMin: num(sp.get("absorb"), TIMELINE_DEFAULTS.absorbMin, 0, 1000),
    };

    const [timeline, spine, undated] = await Promise.all([
      deriveTimeline(filter, opts),
      fetchSpine(filter),
      countUndated(filter),
    ]);

    return json({ ...timeline, spine, undated, options: opts });
  } catch (err) {
    return serverError(err);
  }
}

// Media with no capture time cannot sit on a timeline at all, so the stream
// drops them. Reporting the number is the difference between a view that is
// incomplete and a view that is wrong: the count links back to the grid.
async function countUndated(filter: Parameters<typeof buildFilter>[0]) {
  const { conditions, params } = buildFilter(filter, 1, { collapseGroups: true });
  const rows = await many<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM assets a
     LEFT JOIN ratings r ON r.asset_id = a.id
     WHERE ${conditions.join(" AND ")} AND a.captured_at IS NULL`,
    params,
  );
  return rows[0]?.count ?? 0;
}
