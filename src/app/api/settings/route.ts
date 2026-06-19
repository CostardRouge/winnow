// GET  /api/settings              → réglages courants (débits + pause).
// PATCH /api/settings { scanPerHour?, analyzePerHour? } → met à jour les débits.
//   (0 = illimité). La pause est gérée par POST /api/scan/control.
import { NextRequest } from "next/server";
import { z } from "zod";
import { getSettings, setSettings } from "@/lib/settings";
import { json, badRequest, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

const Body = z.object({
  scanPerHour: z.number().int().min(0).max(1_000_000).optional(),
  analyzePerHour: z.number().int().min(0).max(1_000_000).optional(),
});

export async function GET() {
  try {
    return json(await getSettings(true));
  } catch (err) {
    return serverError(err);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success)
      return badRequest("réglages invalides", parsed.error.issues);
    const updated = await setSettings(parsed.data);
    return json(updated);
  } catch (err) {
    return serverError(err);
  }
}
