// GET  /api/assets/capture-time/suggestions?session=ID — clocks that look
//      wrong in one session (lib/clockSuggestions.ts); without `session`, the
//      most recent sessions worth a look, their number stated in the answer.
// POST /api/assets/capture-time/suggestions { session_id, device, shift_s }
//      — "Not a mistake": that session, body and shift are not offered again.
// Suggestions only: applying one goes through POST /api/assets/capture-time.
import type { NextRequest } from "next/server";
import { z } from "zod";
import { json, badRequest, serverError } from "@/lib/api";
import { identityFromHeaders } from "@/lib/auth";
import {
  dismissSuggestion,
  librarySuggestions,
  sessionSuggestions,
} from "@/lib/clockSuggestions";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const raw = req.nextUrl.searchParams.get("session");
    if (raw == null) return json(await librarySuggestions());
    const id = Number.parseInt(raw, 10);
    if (!Number.isFinite(id) || id <= 0) return badRequest("Invalid session");
    return json({ suggestions: await sessionSuggestions(id) });
  } catch (err) {
    return serverError(err);
  }
}

const Dismiss = z.object({
  session_id: z.number().int().positive(),
  device: z.string().max(400),
  shift_s: z.number().int(),
});

export async function POST(req: NextRequest) {
  try {
    const parsed = Dismiss.safeParse(await req.json());
    if (!parsed.success) return badRequest("Invalid dismissal", parsed.error.issues);
    await dismissSuggestion({
      sessionId: parsed.data.session_id,
      device: parsed.data.device,
      shiftS: parsed.data.shift_s,
      userId: identityFromHeaders(req.headers)?.id ?? null,
    });
    return json({ dismissed: true });
  } catch (err) {
    return serverError(err);
  }
}
