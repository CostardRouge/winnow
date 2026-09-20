// Device attribution (cf. lib/deviceAttribution.ts) — the retroactive repair for
// media whose file never named a camera, most notably DJI drone clips, whose
// MP4s carry no Make/Model at all while the same aircraft's stills carry
// `DJI FC8482`.
//
//   GET                 -> the FOLDERS holding unattributed media, each with its
//                          aggregate evidence and proposal, plus the bodies the
//                          library knows. This is the page.
//   GET ?session_id=N    -> that one folder's media, paged: what an opened card
//                          shows, for the only case that needs a per-file
//                          decision (a folder that held two cameras).
//   POST                -> writes a body. By folder (`session_id`, optionally
//                          `min_score`) or by explicit `ids`; with `device` for
//                          a picked body, without for each target's own
//                          proposal.
//
// Runs INLINE, like the .SRT backfill and unlike the ML one: every signal it
// weighs is already in Postgres, so the whole pass is a couple of queries and
// no original is read. Nothing here belongs on a queue.
import { NextRequest } from "next/server";
import { z } from "zod";
import {
  applyAttribution,
  applyFolder,
  CONFIDENT_SCORE,
  listCandidates,
  listFolders,
  listKnownBodies,
  countUnattributed,
  SIGNAL_WEIGHTS,
} from "@/lib/deviceAttribution";
import { json, badRequest, serverError } from "@/lib/api";

// DB-backed route: never pre-rendered/cached at build time.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;

    // One folder's media — only fetched when a card is opened.
    const sessionParam = sp.get("session_id");
    if (sessionParam) {
      const sessionId = Number(sessionParam);
      if (!Number.isInteger(sessionId) || sessionId <= 0)
        return badRequest("session_id must be a positive integer");
      const limit = Number(sp.get("limit") ?? 50);
      const offset = Number(sp.get("offset") ?? 0);
      const { items, total } = await listCandidates({
        sessionId,
        limit: Number.isFinite(limit) ? limit : 50,
        offset: Number.isFinite(offset) ? offset : 0,
      });
      return json({ items, total });
    }

    // The page: folders, bodies, and the rules the cards are read against.
    const sort = sp.get("sort") === "recent" ? "recent" : "size";
    const [folders, bodies, total] = await Promise.all([
      listFolders({ sort }),
      listKnownBodies(),
      countUnattributed(),
    ]);
    return json({
      folders,
      bodies,
      total,
      // Printed above the list, the way Unplaced prints its donor rules and the
      // Heatmap its keeper-rate floor: the numbers that decided what you see
      // are on screen, not only in the source.
      rules: { weights: SIGNAL_WEIGHTS, confident: CONFIDENT_SCORE },
    });
  } catch (err) {
    return serverError(err);
  }
}

const Body = z
  .object({
    // Folder mode: the whole folder's unattributed media, resolved server-side.
    session_id: z.number().int().positive().optional(),
    // Only media scoring at least this much — the "confident only" action.
    min_score: z.number().int().min(0).max(20).optional(),
    // Per-file mode: an explicit selection made inside an opened folder.
    ids: z.array(z.number().int()).min(1).max(5000).optional(),
    // The body to write, as the gear dimension already spells it (the raw EXIF
    // string — `DJI FC8482`, not "DJI Mini 4 Pro"). Omitted = apply each
    // target's own proposal instead.
    device: z.string().trim().min(1).max(200).optional(),
    camera_model: z.string().trim().min(1).max(200).nullish(),
  })
  .refine((b) => b.session_id != null || b.ids != null, {
    message: "session_id or ids required",
  });

export async function POST(req: NextRequest) {
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success)
      return badRequest("session_id or ids required", parsed.error.issues);
    const { session_id, min_score, ids, device, camera_model } = parsed.data;

    const result =
      session_id != null
        ? await applyFolder({
            sessionId: session_id,
            minScore: min_score,
            device,
            cameraModel: camera_model ?? null,
          })
        : await applyAttribution({
            ids: ids ?? [],
            device,
            cameraModel: camera_model ?? null,
          });
    return json(result);
  } catch (err) {
    return serverError(err);
  }
}
