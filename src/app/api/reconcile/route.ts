// POST /api/reconcile { root_id? } → appariement finaux → sources (§8).
// MVP : la réconciliation auto (worker dédié, clé de liaison C1 à trancher §12.4)
// est prévue en V2. Endpoint présent pour figer le contrat d'API.
import { json } from "@/lib/api";

export async function POST() {
  return json(
    {
      status: "not_implemented",
      message:
        "Réconciliation finaux→sources prévue en V2 (cf. §8 et décision §12.4).",
    },
    501,
  );
}
