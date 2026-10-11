// POST /api/assets/geotag/points { points: [{ id, lat, lon, source, import_id? }] }
// → places each frame at its own point: the write behind the Unplaced view's
// "Follow a track…" (docs/UNPLACED.md §11). 'track' or 'inferred' only, never
// an overwrite, never written into an original — the rules and the reasons
// are in src/lib/geotagPoints.ts; this is the thin wrapper.
import { NextRequest } from "next/server";
import { z } from "zod";
import { writeGeotagPoints } from "@/lib/geotagPoints";
import { json, badRequest, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

// The geotag targets route's own cap: the largest card this library holds is
// far below it, and a dialog never lists more.
const CAP = 20000;

const Body = z.object({
  points: z
    .array(
      z.object({
        id: z.number().int(),
        lat: z.number().min(-90).max(90),
        lon: z.number().min(-180).max(180),
        source: z.enum(["track", "inferred"]),
        import_id: z.number().int().nullable().optional(),
      }),
    )
    // A 'track' position always names the import that measured it.
    .refine((ps) => ps.every((p) => p.source !== "track" || p.import_id != null), "a 'track' point needs its import_id")
    .min(1)
    .max(CAP),
});

export async function POST(req: NextRequest) {
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return badRequest("points required", parsed.error.issues);
    return json(await writeGeotagPoints(parsed.data.points));
  } catch (err) {
    return serverError(err);
  }
}
