// GET /api/assets/unplaced/aside → the unplaced media the Unplaced view keeps
// off its cards (docs/UNPLACED.md §12): screenshots and files saved from
// another app (the "Not a place" dialog), and graded exports with the source
// clip each was exported from (the "Graded exports" dialog). Read-only — the
// dialogs write through the existing geo-exempt and geotag/points routes.
import { listAside } from "@/lib/unplacedAside";
import { json, serverError } from "@/lib/api";

// DB-backed route: never pre-rendered/cached at build time.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return json(await listAside());
  } catch (err) {
    return serverError(err);
  }
}
