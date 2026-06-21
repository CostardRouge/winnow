// GET /api/pipeline/heic-rotation -> scans every `ready` HEIC/HEIF photo and
// reports which derivatives were rotated twice by the pre-fix worker (container
// transform + EXIF orientation both applied). Read-only: it reads metadata only
// (exiftool, no pixel decode) and never touches the DB or the derivatives. The
// fix is applied separately via POST /api/assets/regenerate with the ids below.
//
// Triggered by a button on the Pipeline "HEIC rotation" page — never polled —
// since the scan walks the originals on the NAS and can take a while.
import { scanHeicRotation } from "@/lib/heicRotation";
import { json, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";
// Allow a long scan on platforms that honour the segment timeout (self-hosted
// Node ignores it; harmless there).
export const maxDuration = 300;

// Cap the rows we return with paths/thumbnails so a huge backlog can't bloat the
// response. `affectedIds` still carries every id so "Fix all" stays exhaustive.
const ITEM_CAP = 500;

export async function GET() {
  try {
    const { scanned, missing, affected } = await scanHeicRotation();
    return json({
      scanned,
      missing,
      ok: scanned - affected.length - missing,
      affectedCount: affected.length,
      items: affected.slice(0, ITEM_CAP),
      itemsCapped: affected.length > ITEM_CAP,
      affectedIds: affected.map((a) => a.id),
      ranAtMs: Date.now(),
    });
  } catch (err) {
    return serverError(err);
  }
}
