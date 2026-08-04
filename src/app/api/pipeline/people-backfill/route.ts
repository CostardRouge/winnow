// POST /api/pipeline/people-backfill -> enqueue ONE sweep that clusters every
// not-yet-assigned face into people (cf. lib/people.assignAllPending) — the
// backfill for a library whose faces were detected before the People feature
// existed. Pure DB work over the stored embeddings: no container call, so it is
// not paced by mlPerHour and finishes in minutes, not days. New analyses assign
// their own faces inline (cf. lib/ml.runMlJob), so this is a one-shot catch-up,
// idempotent and safe to re-click (the jobId coalesces repeats).
import { config } from "@/lib/config";
import { enqueuePeopleBackfill } from "@/lib/queue";
import { peopleCoverage } from "@/lib/people";
import { json, badRequest, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    if (!config.ml.enabled || !config.ml.faces.enabled) {
      return badRequest(
        "Face detection is disabled (set ML_ENABLED=true and ML_FACES_ENABLED=true)",
      );
    }
    // The count the sweep is about to process — the button's feedback line.
    const coverage = await peopleCoverage();
    await enqueuePeopleBackfill();
    return json({ queued: coverage.unassigned });
  } catch (err) {
    return serverError(err);
  }
}
