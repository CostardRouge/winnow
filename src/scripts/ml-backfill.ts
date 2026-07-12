// CLI helper: enqueue an ML-analysis job (faces + OCR, cf. lib/ml.ts) for every
// asset that has a derivative but no analysis yet — the one-shot backfill of an
// existing library. The models feed on the WebP proxy/poster the pipeline
// already generated, so the NAS RAWs are never re-read. Idempotent: re-running
// only picks up assets still pending; the mlPerHour setting (Pipeline page)
// paces the queue so an 80k library drips through without pinning the box.
//
// Usage:
//   npm run ml-backfill              # enqueue onto the ml queue
//   npm run ml-backfill -- --force   # also re-enqueue assets already analyzed
//                                    # (e.g. after a container/model upgrade)
// Then run `npm run worker` (or leave it running) to drain the queue.
import { many, pool, q } from "../lib/db";
import { config } from "../lib/config";
import { enqueueMl } from "../lib/queue";

async function main() {
  const force = process.argv.slice(2).includes("--force");

  if (!config.ml.enabled) {
    console.error(
      "ML analysis is disabled — set ML_ENABLED=true (and ML_BASE_URL) first.",
    );
    process.exit(1);
  }

  // Only live assets whose derivative exists (photo proxy / video poster).
  // Without --force we skip anything already analyzed or deliberately skipped;
  // the partial index assets_ml_todo_idx serves exactly the pending set.
  const rows = await many<{ id: number }>(
    force
      ? `SELECT id FROM assets
           WHERE deleted_at IS NULL
             AND (CASE WHEN media_type = 'video' THEN thumb_key
                       ELSE COALESCE(proxy_key, thumb_key) END) IS NOT NULL
           ORDER BY id`
      : `SELECT id FROM assets
           WHERE ml_status = 'pending' AND deleted_at IS NULL
             AND (CASE WHEN media_type = 'video' THEN thumb_key
                       ELSE COALESCE(proxy_key, thumb_key) END) IS NOT NULL
           ORDER BY id`,
  );

  if (force && rows.length) {
    // A forced re-run must go through the full lifecycle again.
    await q(
      "UPDATE assets SET ml_status='pending', ml_error=NULL, updated_at=now() WHERE id = ANY($1)",
      [rows.map((r) => r.id)],
    );
  }

  console.log(
    `Enqueuing ${rows.length} ml job(s)${force ? " (force: includes already-analyzed)" : ""}…`,
  );
  let n = 0;
  for (const r of rows) {
    await enqueueMl(r.id);
    if (++n % 1000 === 0) console.log(`  queued ${n}/${rows.length}`);
  }
  console.log(`Done. Queued ${n}. Run \`npm run worker\` to process them.`);

  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
