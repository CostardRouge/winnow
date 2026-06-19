// GET /api/stats → vue d'ensemble : compteurs médias (total/analysés/en attente),
// activité des files (scan/analyse/import), état de pause et débits réglés.
// Source unique pour le bandeau de chiffres + le panneau de contrôle du tableau de bord.
import { one } from "@/lib/db";
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
    return { scan: 0, import: 0 }; // tables absentes avant migration
  }
}

// Route adossée à la DB/Redis : jamais pré-rendue/mise en cache au build.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const counts = await one<{
      total: number;
      photos: number;
      videos: number;
      analyzed: number;
      pending: number;
      errors: number;
      skipped: number;
      picks: number;
    }>(
      `SELECT
         count(*)                                                            AS total,
         count(*) FILTER (WHERE media_type = 'photo')                        AS photos,
         count(*) FILTER (WHERE media_type = 'video')                        AS videos,
         count(*) FILTER (WHERE derivative_status = 'ready')                 AS analyzed,
         count(*) FILTER (WHERE derivative_status IN ('pending','processing')) AS pending,
         count(*) FILTER (WHERE derivative_status = 'error')                 AS errors,
         count(*) FILTER (WHERE derivative_status = 'skipped')               AS skipped,
         count(*) FILTER (WHERE r.verdict = 'pick')                          AS picks
       FROM assets a
       LEFT JOIN ratings r ON r.asset_id = a.id`,
    );

    // Files BullMQ + réglages : tolérants à une panne Redis (valeurs nulles plutôt
    // qu'une 500 qui masquerait les compteurs médias).
    let queues = null;
    try {
      queues = await getQueueStats();
    } catch {
      /* Redis indisponible : on renvoie quand même les compteurs DB */
    }
    const settings = await getSettings();
    const fails = await failureCounts();

    return json({
      assets: counts ?? {
        total: 0,
        photos: 0,
        videos: 0,
        analyzed: 0,
        pending: 0,
        errors: 0,
        skipped: 0,
        picks: 0,
      },
      queues,
      paused: queues?.paused ?? settings.scanPaused,
      settings: {
        scanPerHour: settings.scanPerHour,
        analyzePerHour: settings.analyzePerHour,
      },
      failures: {
        derivative: Number(counts?.errors ?? 0),
        scan: fails.scan,
        import: fails.import,
      },
    });
  } catch (err) {
    return serverError(err);
  }
}
