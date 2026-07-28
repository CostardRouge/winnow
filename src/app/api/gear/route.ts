// GET /api/gear -> the shelf: every camera body the library was shot with, each
// with the lenses used on it, and both tallied separately for Incoming and the
// Gallery (the two grids a card can link to). Single source for the /gear page
// (cf. lib/gear.ts for the scope rules).
import { listCameras } from "@/lib/gear";
import { json, serverError } from "@/lib/api";

// DB-backed route: never pre-rendered/cached at build time (otherwise Next runs
// the query at build and freezes an empty shelf into the image).
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return json({ cameras: await listCameras() });
  } catch (err) {
    return serverError(err);
  }
}
