// GET /api/export/targets → where an export can be sent, from this deployment.
//
// The export modals render a destination picker only when there is a real
// choice: a stock install has EXPORT_DIR and nothing else, so the picker stays
// hidden and the flow is exactly as it was. Turning IMMICH_ENABLED on is what
// makes the second option appear — no rebuild, no separate UI setting.
//
// `?probe=1` additionally pings the Immich server and validates the API key, so
// the modal can say "unreachable" while the user is still looking at it instead
// of after a job has failed. The probe is skipped by default because it costs
// two round trips to another host.
import { config } from "@/lib/config";
import { immichConfigured, immichPing } from "@/lib/immich";
import { json, serverError } from "@/lib/api";

// Reads the live config + pings another host: never pre-rendered at build time.
export const dynamic = "force-dynamic";

export type ExportTarget = {
  id: "capture_one" | "immich";
  label: string;
  hint: string;
  available: boolean;
  /** Set when a probe found the target configured but not usable. */
  error?: string;
};

export async function GET(req: Request) {
  try {
    const probe = new URL(req.url).searchParams.get("probe") === "1";

    const targets: ExportTarget[] = [
      {
        id: "capture_one",
        label: "Export folder",
        hint: "Copies the originals to the local export folder — the files you develop (Capture One, Lightroom…).",
        available: true,
      },
    ];

    if (immichConfigured()) {
      const album =
        config.immich.albumMode === "fixed"
          ? `the “${config.immich.albumName}” album`
          : config.immich.albumMode === "job"
            ? "an album named after the export"
            : "the timeline";
      const target: ExportTarget = {
        id: "immich",
        label: "Immich",
        hint: `Uploads the originals to ${config.immich.baseUrl} into ${album}. Sidecars (SRT/XML/THM) don’t travel.`,
        available: true,
      };
      if (probe) {
        const ping = await immichPing();
        if (!ping.ok) {
          target.available = false;
          target.error = ping.error ?? "unreachable";
        }
      }
      targets.push(target);
    }

    return json({ targets });
  } catch (err) {
    return serverError(err);
  }
}
