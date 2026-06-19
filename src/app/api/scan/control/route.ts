// POST /api/scan/control { action: "pause" | "resume" }
//   pause  : suspend indexing + derivative generation (persisted in Redis +
//            DB flag read by the indexer to stop mid-scan).
//   resume : restart the queues and re-enqueue the source roots to finish any
//            interrupted scan (incremental -> already-known files are skipped).
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
      return badRequest("action required (pause|resume)", parsed.error.issues);
    const paused = parsed.data.action === "pause";

    // DB flag (for stopping mid-scan) + Redis pause (new jobs).
    await setSettings({ scanPaused: paused });
    await setScanPaused(paused);

    if (!paused) {
      // Resume: re-enqueue the indexable roots, incoming first.
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
