// GET /api/gear -> the shelf: every camera body and every lens the library was
// shot with, each with its frame count / date span / companion piece of gear.
// Single source for the /gear page (cf. lib/gear.ts for the scope rules).
import { listCameras, listLenses } from "@/lib/gear";
import { json, serverError } from "@/lib/api";

// DB-backed route: never pre-rendered/cached at build time (otherwise Next runs
// the query at build and freezes an empty shelf into the image).
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [cameras, lenses] = await Promise.all([listCameras(), listLenses()]);
    return json({ cameras, lenses });
  } catch (err) {
    return serverError(err);
  }
}
