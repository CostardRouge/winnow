// POST /api/scan/control { action: "pause" | "resume" }
//   pause  : suspend indexation + génération de dérivés (persisté dans Redis +
//            drapeau DB lu par l'indexer pour s'arrêter en cours de scan).
//   resume : relance les files et ré-enfile les roots source pour terminer tout
//            scan interrompu (incrémental → les fichiers déjà connus sont sautés).
import { NextRequest } from "next/server";
import { z } from "zod";
import { many } from "@/lib/db";
import { config } from "@/lib/config";
import { setScanPaused, enqueueIndex, PRIORITY } from "@/lib/queue";
import { setSettings } from "@/lib/settings";
import { json, badRequest, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

const Body = z.object({ action: z.enum(["pause", "resume"]) });

export async function POST(req: NextRequest) {
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success)
      return badRequest("action requise (pause|resume)", parsed.error.issues);
    const paused = parsed.data.action === "pause";

    // Drapeau DB (pour l'arrêt en cours de scan) + pause Redis (nouveaux jobs).
    await setSettings({ scanPaused: paused });
    await setScanPaused(paused);

    if (!paused) {
      // Reprise : ré-enfile les roots indexables, incoming en priorité.
      const roots = await many<{ id: number; path: string }>(
        "SELECT id, path FROM roots WHERE kind IN ('source','inbox')",
      );
      for (const r of roots) {
        await enqueueIndex(r.id, {
          priority:
            r.path === config.import.incomingDir
              ? PRIORITY.high
              : PRIORITY.normal,
        });
      }
    }

    return json({ paused });
  } catch (err) {
    return serverError(err);
  }
}
