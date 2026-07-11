// GET /api/stats -> overview: media counters (total/analyzed/pending),
// queue activity (scan/analyze/import), pause state and configured rates.
// Single source for the numbers banner + the dashboard control panel.
import { one } from "@/lib/db";
import { config } from "@/lib/config";
import { getQueueStats } from "@/lib/queue";
import { getSettings } from "@/lib/settings";
import { json, serverError } from "@/lib/api";

async function failureCounts() {
  try {
    const row = await one<{ scan: number; imp: number }>(
      `SELECT
         (SELECT count(*) FROM scan_failures WHERE resolved_at IS NULL)        AS scan,
         (SELECT COALESCE(sum(failed), 0) FROM import_batches WHERE failed > 0) AS imp`,
    );
    return { scan: Number(row?.scan ?? 0), import: Number(row?.imp ?? 0) };
  } catch {
    return { scan: 0, import: 0 }; // tables absent before migration
  }
}

// DB/Redis-backed route: never pre-rendered/cached at build time.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const counts = await one<{
      total: number;
      media: number;
      pairs: number;
      photos: number;
      videos: number;
      analyzed: number;
      pending: number;
      errors: number;
      skipped: number;
      ml_ready: number;
      ml_pending: number;
      ml_errors: number;
    }>(
      // `total` counts physical files; `media` counts logical items, where a
      // RAW+JPEG pair counts once (its companion is excluded). `pairs` is the
      // number of such RAW+JPEG groups. See lib/pairing.ts.
      // Scoped to the live library (deleted_at IS NULL) so these counters match
      // what the triage pages list — they all filter soft-deleted assets out
      // (cf. lib/filter.ts). Otherwise a soft-deleted pending/error item would
      // keep inflating a nav badge for a row no page ever shows.
      `SELECT
         count(*)                                                            AS total,
         count(*) FILTER (WHERE group_role IS DISTINCT FROM 'companion')     AS media,
         count(*) FILTER (WHERE group_role = 'companion')                    AS pairs,
         count(*) FILTER (WHERE media_type = 'photo')                        AS photos,
         count(*) FILTER (WHERE media_type = 'video')                        AS videos,
         count(*) FILTER (WHERE derivative_status = 'ready')                 AS analyzed,
         count(*) FILTER (WHERE derivative_status IN ('pending','processing')) AS pending,
         count(*) FILTER (WHERE derivative_status = 'error')                 AS errors,
         count(*) FILTER (WHERE derivative_status = 'skipped')               AS skipped,
         count(*) FILTER (WHERE ml_status = 'ready')                         AS ml_ready,
         count(*) FILTER (WHERE ml_status IN ('pending','processing'))       AS ml_pending,
         count(*) FILTER (WHERE ml_status = 'error')                         AS ml_errors
       FROM assets a
       WHERE a.deleted_at IS NULL`,
    );

    // BullMQ queues + settings: tolerant of a Redis outage (null values rather
    // than a 500 that would hide the media counters).
    let queues = null;
    try {
      queues = await getQueueStats();
    } catch {
      /* Redis unavailable: we still return the DB counters */
    }
    const settings = await getSettings();
    const fails = await failureCounts();

    return json({
      assets: counts ?? {
        total: 0,
        media: 0,
        pairs: 0,
        photos: 0,
        videos: 0,
        analyzed: 0,
        pending: 0,
        errors: 0,
        skipped: 0,
        ml_ready: 0,
        ml_pending: 0,
        ml_errors: 0,
      },
      queues,
      paused: queues?.paused ?? settings.scanPaused,
      settings: {
        scanPerHour: settings.scanPerHour,
        analyzePerHour: settings.analyzePerHour,
        mlPerHour: settings.mlPerHour,
      },
      // ML is only surfaced when the feature is on: the sliders/counters would
      // otherwise show a pipeline stage that can never progress.
      mlEnabled: config.ml.enabled,
      failures: {
        derivative: Number(counts?.errors ?? 0),
        scan: fails.scan,
        import: fails.import,
        ml: Number(counts?.ml_errors ?? 0),
      },
    });
  } catch (err) {
    return serverError(err);
  }
}
