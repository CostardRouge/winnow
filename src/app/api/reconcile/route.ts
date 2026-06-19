// POST /api/reconcile { root_id? } → matching finals → sources (§8).
// MVP: auto reconciliation (dedicated worker, linking key C1 to be decided §12.4)
// is planned for V2. Endpoint present to freeze the API contract.
import { json } from "@/lib/api";

export async function POST() {
  return json(
    {
      status: "not_implemented",
      message:
        "Reconciliation finals→sources planned for V2 (see §8 and decision §12.4).",
    },
    501,
  );
}
