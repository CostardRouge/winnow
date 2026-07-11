// GET /api/assets/:id/similar ?limit=&max_distance= -> the visually closest
// media, ranked by perceptual-hash distance (cf. lib/ml.ts). Unlike the
// byte-identical dedup (content_hash), this surfaces NEAR-duplicates: the same
// frame re-exported/resized, burst neighbours, a slightly different crop — the
// "which of these do I keep" question of culling.
//
// Distance = Hamming distance between the two 64-bit dHashes (0 = perceptually
// identical, ~10 = very close, >16 = probably unrelated). The XOR+popcount runs
// in SQL over the indexed-but-sequential phash column: a single int operation
// per row stays in the low milliseconds over an 80k library.
import { NextRequest } from "next/server";
import { many, one } from "@/lib/db";
import { json, badRequest, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 12;
const DEFAULT_MAX_DISTANCE = 16;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const id = Number.parseInt((await params).id, 10);
    if (!Number.isFinite(id)) return badRequest("invalid id");
    const sp = req.nextUrl.searchParams;
    const limit = Math.min(
      Math.max(Number.parseInt(sp.get("limit") ?? "", 10) || DEFAULT_LIMIT, 1),
      100,
    );
    const maxDistance = Math.min(
      Math.max(
        Number.parseInt(sp.get("max_distance") ?? "", 10) || DEFAULT_MAX_DISTANCE,
        0,
      ),
      64,
    );

    const source = await one<{ phash: string | null }>(
      "SELECT phash FROM assets WHERE id = $1",
      [id],
    );
    if (!source) return badRequest("asset not found");
    // Not analyzed yet (or the metric failed): nothing to compare against.
    if (source.phash == null) return json({ items: [], analyzed: false });

    const items = await many<{
      id: number;
      filename: string;
      ext: string;
      media_type: "photo" | "video";
      captured_at: string | null;
      distance: number;
    }>(
      `SELECT a.id, a.filename, a.ext, a.media_type, a.captured_at,
              bit_count((a.phash # $2::bigint)::bit(64))::int AS distance
       FROM assets a
       WHERE a.phash IS NOT NULL
         AND a.id <> $1
         AND a.deleted_at IS NULL
         AND bit_count((a.phash # $2::bigint)::bit(64)) <= $3
       ORDER BY distance ASC, a.id ASC
       LIMIT $4`,
      [id, source.phash, maxDistance, limit],
    );

    return json({ items, analyzed: true });
  } catch (err) {
    return serverError(err);
  }
}
