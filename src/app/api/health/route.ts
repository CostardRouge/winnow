// GET /api/health → sonde de vivacité (utilisée par le healthcheck Docker).
// Vérifie que l'app répond et que Postgres est joignable.
import { q } from "@/lib/db";
import { json, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await q("SELECT 1");
    return json({ status: "ok", db: "up" });
  } catch (err) {
    return serverError(err);
  }
}
