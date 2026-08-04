// CLI helper: cluster every not-yet-assigned face into people (cf.
// lib/people.ts) — the one-shot backfill for a library whose faces were
// detected before the People feature existed. Runs the sweep DIRECTLY (no
// queue, no worker needed): it is pure DB work over the stored embeddings, so
// there is nothing to pace and nothing to distribute. Idempotent — re-running
// only picks up faces still without a person (new analyses assign their own
// faces inline, cf. lib/ml.runMlJob).
//
// Usage:
//   npm run people-backfill
//
// One-click counterpart: the "Group into people" button on the /people page
// (POST /api/pipeline/people-backfill), which runs the same sweep through the
// worker instead.
import { pool } from "../lib/db";
import { config } from "../lib/config";
import { assignAllPending, peopleCoverage } from "../lib/people";

async function main() {
  if (!config.ml.faces.enabled) {
    console.error(
      "Face detection is disabled — set ML_FACES_ENABLED=true first (there would be nothing to cluster).",
    );
    process.exit(1);
  }

  const before = await peopleCoverage();
  console.log(
    `Clustering ${before.unassigned} unassigned face(s) into people (threshold ${config.ml.person.minSimilarity})…`,
  );
  const assigned = await assignAllPending((msg) => console.log(msg));
  const after = await peopleCoverage();
  console.log(
    `Done. Assigned ${assigned} face(s); the library now has ${after.people} people.`,
  );

  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
