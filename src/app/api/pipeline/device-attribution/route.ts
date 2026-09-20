// Device attribution (cf. lib/deviceAttribution.ts) — the retroactive repair for
// media whose file never named a camera, most notably DJI drone clips, whose
// MP4s carry no Make/Model at all while the same aircraft's stills carry
// `DJI FC8482`.
//
//   GET  -> the candidates with their evidence + the bodies the library knows,
//           so the Pipeline page can list, rank and pre-select them.
//   POST -> writes a body onto the given ids: the one the caller picked
//           (device_source='manual'), or each row's own suggestion when no
//           device is given (device_source='derived').
//
// Runs INLINE, like the .SRT backfill and unlike the ML one: every signal it
// weighs is already in Postgres, so the whole pass is a couple of queries and
// no original is read. Nothing here belongs on a queue.
import { NextRequest } from "next/server";
import { z } from "zod";
import {
  applyAttribution,
  listCandidates,
  listKnownBodies,
} from "@/lib/deviceAttribution";
import { json, badRequest, serverError } from "@/lib/api";

// DB-backed route: never pre-rendered/cached at build time.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const limit = Number(sp.get("limit") ?? 200);
    const offset = Number(sp.get("offset") ?? 0);
    const [{ items, total }, bodies] = await Promise.all([
      listCandidates({
        limit: Number.isFinite(limit) ? limit : 200,
        offset: Number.isFinite(offset) ? offset : 0,
      }),
      listKnownBodies(),
    ]);
    return json({ items, total, bodies });
  } catch (err) {
    return serverError(err);
  }
}

const Body = z.object({
  ids: z.array(z.number().int()).min(1).max(5000),
  // The body to write, as the gear dimension already spells it (the raw EXIF
  // string — `DJI FC8482`, not "DJI Mini 4 Pro"). Omitted = apply each row's
  // own suggestion instead.
  device: z.string().trim().min(1).max(200).optional(),
  camera_model: z.string().trim().min(1).max(200).nullish(),
});

export async function POST(req: NextRequest) {
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return badRequest("ids required", parsed.error.issues);
    const { ids, device, camera_model } = parsed.data;

    const result = await applyAttribution({
      ids,
      device,
      cameraModel: camera_model ?? null,
    });
    return json(result);
  } catch (err) {
    return serverError(err);
  }
}
