// GET /api/assets/unplaced → the Incoming geotagging backlog as folder groups,
// each with a suggested position and the rules that produced it. Feeds the
// Unplaced view (/library/incoming/unplaced). All the logic is in
// src/lib/unplaced.ts; this is the thin wrapper the project's shape asks for.
import { listUnplaced } from "@/lib/unplaced";
import { json, serverError } from "@/lib/api";

// DB-backed route: never pre-rendered/cached at build time.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return json(await listUnplaced());
  } catch (err) {
    return serverError(err);
  }
}
