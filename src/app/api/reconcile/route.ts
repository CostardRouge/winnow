// POST /api/reconcile { root_id? } → finals → sources reconciliation (§8).
// Links each edited "final" back to the source original it was derived from so
// the app can pair before/after. Runs over the already-indexed library, so it's
// retroactive and safe to re-run (idempotent — cf. lib/reconcile.ts). With a
// `root_id` it scopes to that finals root; without one it sweeps every finals
// root (and picks up finals that newly match after sources were added).
import { json, badRequest, serverError } from "@/lib/api";
import { reconcileEdits } from "@/lib/reconcile";

export async function POST(req: Request) {
  try {
    // Tolerate an empty body (no root_id → reconcile everything).
    const body = (await req.json().catch(() => ({}))) as { root_id?: unknown };
    let rootId: number | undefined;
    if (body && body.root_id != null) {
      rootId = Number(body.root_id);
      if (!Number.isInteger(rootId) || rootId <= 0) {
        return badRequest("root_id must be a positive integer");
      }
    }
    const result = await reconcileEdits({ rootId });
    return json(result);
  } catch (err) {
    return serverError(err);
  }
}
