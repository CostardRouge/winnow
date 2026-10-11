// Device attribution (cf. lib/deviceAttribution.ts) — the retroactive repair for
// media whose file never named a camera, most notably DJI drone clips, whose
// MP4s carry no Make/Model at all while the same aircraft's stills carry
// `DJI FC8482`.
//
//   GET                 -> the FOLDERS holding unattributed media, each with its
//                          aggregate evidence and proposal, plus the bodies the
//                          library knows. This is the page. `?source=` picks
//                          the half: incoming (default), gallery or all.
//   GET ?session_id=N    -> that one folder's media, paged: what an opened card
//                          shows, for the only case that needs a per-file
//                          decision (a folder that held two cameras).
//   POST                -> writes a body. By folder (`session_id`, optionally
//                          `min_score`) or by explicit `ids`; with `device` for
//                          a picked body, without for each target's own
//                          proposal. `mode` decides how far it may go:
//                            fill     (default) only media with no body;
//                            override replace whatever the ids carry, the
//                                     file's own value included (ids + device);
//                            revert   put the ids back to what their files say;
//                            name     a camera no file names, typed by hand
//                                     (`device` is the name) — 'named';
//                            none     not a camera at all — 'none', no body.
//                          The two that can change an existing body are
//                          separate modes on purpose: nothing reaches them by
//                          leaving a field out. name / none work by folder (its
//                          backlog) or by ids (holes and earlier attributions
//                          only — never a body a file declared).
//
// Runs INLINE, like the .SRT backfill and unlike the ML one: every signal it
// weighs is already in Postgres, so the whole pass is a couple of queries and
// no original is read. Nothing here belongs on a queue.
import { NextRequest } from "next/server";
import { z } from "zod";
import {
  applyAttribution,
  applyFolder,
  overrideDevice,
  revertDevice,
  labelDevice,
  DeviceNameTaken,
  CONFIDENT_SCORE,
  listCandidates,
  listFolders,
  listKnownBodies,
  countUnattributedBySource,
  countLabelled,
  SIGNAL_WEIGHTS,
  type DeviceSource,
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
    // Incoming unless asked otherwise — the Gallery is accepted as it is, so it
    // is shown on request and never counted (cf. backlogScopeSql).
    const sort = sp.get("sort") === "recent" ? "recent" : "size";
    const sourceParam = sp.get("source");
    const source: DeviceSource =
      sourceParam === "gallery" || sourceParam === "all" ? sourceParam : "incoming";
    const [folders, bodies, counts, labelled] = await Promise.all([
      listFolders({ sort, source }),
      listKnownBodies(),
      countUnattributedBySource(),
      countLabelled(source),
    ]);
    const total =
      source === "all"
        ? counts.incoming + counts.gallery
        : counts[source];
    return json({
      folders,
      bodies,
      source,
      total,
      counts,
      labelled,
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
    // target's own proposal instead. In `name` mode, the name typed.
    device: z.string().trim().min(1).max(200).optional(),
    camera_model: z.string().trim().min(1).max(200).nullish(),
    // How far the write may go (see the header). Replacing or reverting a
    // body is a decision about media you have looked at, never a predicate
    // over a folder; filling, naming and "not a camera" can be either.
    mode: z.enum(["fill", "override", "revert", "name", "none"]).default("fill"),
  })
  .refine((b) => b.session_id != null || b.ids != null, {
    message: "session_id or ids required",
  })
  .refine(
    (b) =>
      (b.mode !== "override" && b.mode !== "revert") ||
      (b.ids != null && b.session_id == null),
    { message: "override and revert take explicit ids, never a folder" },
  )
  .refine((b) => b.mode !== "override" || b.device != null, {
    message: "override needs the body to write",
  })
  .refine((b) => b.mode !== "name" || b.device != null, {
    message: "name needs the camera’s name",
  })
  .refine((b) => b.mode !== "none" || b.device == null, {
    message: "none writes no body",
  });

export async function POST(req: NextRequest) {
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success)
      return badRequest(
        parsed.error.issues[0]?.message ?? "invalid body",
        parsed.error.issues,
      );
    const { session_id, min_score, ids, device, camera_model, mode } =
      parsed.data;

    if (mode === "override")
      return json(
        await overrideDevice({
          ids: ids ?? [],
          device: device!,
          cameraModel: camera_model ?? null,
        }),
      );
    if (mode === "revert") return json(await revertDevice(ids ?? []));
    if (mode === "name" || mode === "none") {
      try {
        return json(
          await labelDevice({
            ids,
            sessionId: session_id,
            name: mode === "name" ? device! : null,
          }),
        );
      } catch (err) {
        if (err instanceof DeviceNameTaken) return badRequest(err.message);
        throw err;
      }
    }

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
