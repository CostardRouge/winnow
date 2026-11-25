// POST /api/assets/capture-time — correct the capture time of a selection
// whose camera clock was wrong (migration 0061, docs/CAPTURE-TIME.md).
//
//   { ids, devices?, mode: "shift", shift_s }          add N seconds
//   { ids, devices?, mode: "set", set: { id, local } } one frame's local time;
//                                                      the others keep their gaps
//   { ids, devices?, mode: "match", pair: { wrong_id, right_id, round } }
//                                                      two frames of one moment
//   { ids, devices?, mode: "zone", zone: { from, to } } the camera's zone vs the
//                                                      place's (IANA names)
//   { ids, devices?, mode: "revert" }                   back to what the files say
//   + apply: false (default) → the preview; apply: true → the record.
//
// Nothing here writes into an original: a correction is a shift stored beside
// the file's own time, undone from Settings › Pipeline › Dates & places
// (DELETE /api/assets/capture-time/corrections/:id). After the commit, the
// copies already pushed to Immich are given the corrected date
// (lib/immichDates.ts); what that did is on the answer and the record. A selection is widened to
// whole burst piles and pairs before anything is decided (lib/captureCorrections.ts).
// Editor, like geotag: the default for a mutation under /api/assets.
import type { NextRequest } from "next/server";
import { z } from "zod";
import { json, badRequest, serverError } from "@/lib/api";
import { authViaFromHeaders, identityFromHeaders } from "@/lib/auth";
import {
  CorrectionError,
  applyCorrection,
  movedRows,
  planCorrection,
  recordImmich,
} from "@/lib/captureCorrections";
import { pushCapturedDates } from "@/lib/immichDates";
import { MAX_SHIFT_S } from "@/lib/captureCorrectionTypes";

export const dynamic = "force-dynamic";

const Body = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(50_000),
  devices: z.array(z.string()).nullable().optional(),
  mode: z.enum(["shift", "set", "match", "zone", "revert"]),
  shift_s: z.number().int().min(-MAX_SHIFT_S).max(MAX_SHIFT_S).optional(),
  set: z.object({ id: z.number().int().positive(), local: z.string().min(1).max(32) }).optional(),
  pair: z
    .object({
      wrong_id: z.number().int().positive(),
      right_id: z.number().int().positive(),
      round: z.boolean(),
    })
    .optional(),
  zone: z.object({ from: z.string().min(1).max(64), to: z.string().min(1).max(64) }).optional(),
  apply: z.boolean().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return badRequest("Invalid correction", parsed.error.issues);
    const b = parsed.data;
    const request = {
      ids: b.ids,
      devices: b.devices ?? null,
      mode: b.mode,
      shiftS: b.shift_s,
      set: b.set,
      pair: b.pair
        ? { wrongId: b.pair.wrong_id, rightId: b.pair.right_id, round: b.pair.round }
        : undefined,
      zone: b.zone,
    };
    if (!b.apply) return json({ plan: await planCorrection(request) });
    const done = await applyCorrection(request, {
      userId: identityFromHeaders(req.headers)?.id ?? null,
      via: authViaFromHeaders(req.headers),
    });
    const immich = await pushCapturedDates(done.ids);
    if (immich) await recordImmich(done.id, "immich", immich);
    return json({ correction: done.id, plan: done.plan, immich, moved: await movedRows(done.ids) });
  } catch (err) {
    if (err instanceof CorrectionError) return badRequest(err.message);
    return serverError(err);
  }
}
