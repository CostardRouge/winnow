// GET /api/search?q=<natural language>&limit=N -> CLIP semantic search.
//
// Embeds the query text with the same CLIP model that produced the stored image
// embeddings (lib/ml.ts embedText), then ranks the library by cosine distance
// (pgvector `<=>`) — "the sunset beach shots", "people around a table", "a bird
// close-up". Exact flat scan over asset_clip (no ANN index; see migration 0025),
// which stays low-ms over a ~100k library.
//
// Returns the usual grid rows so the results render like any other gallery.
// Companions (a pair's RAW, a Live Photo's .mov) are collapsed to the displayed
// primary. Depends on ML being enabled + a CLIP backfill having run.
import { NextRequest } from "next/server";
import { many } from "@/lib/db";
import { config } from "@/lib/config";
import { embedText } from "@/lib/ml";
import { GRID_SELECT, GRID_FROM } from "@/lib/assetQuery";
import { json, badRequest, serverError } from "@/lib/api";
import type { AssetGridRow } from "@/lib/types";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 200;

type SearchRow = AssetGridRow & { distance: number };

export async function GET(req: NextRequest) {
  try {
    // Surfaced to the UI so it can show a friendly "turn it on / back-fill"
    // hint rather than an error when the feature isn't wired yet.
    if (!config.ml.enabled || !config.ml.clip.enabled) {
      return json({ items: [], enabled: false, model: config.ml.clip.model });
    }

    const sp = req.nextUrl.searchParams;
    const q = (sp.get("q") ?? "").trim();
    if (!q) return badRequest("q (the search text) is required");
    if (q.length > 300) return badRequest("q is too long (max 300 chars)");

    const limit = Math.min(
      Math.max(Number.parseInt(sp.get("limit") ?? "", 10) || DEFAULT_LIMIT, 1),
      MAX_LIMIT,
    );

    // Embed the query with the model's textual head (one container call). A
    // provider/container problem surfaces as a 502 rather than a generic 500.
    let vector: number[];
    try {
      vector = await embedText(q);
    } catch (err) {
      return json(
        { error: "embedding failed", detail: (err as Error).message },
        502,
      );
    }
    const literal = `[${vector.join(",")}]`;

    // Rank first (cheap: one cosine op per analyzed row), THEN apply the heavy
    // grid projection to only the top-N — so the tag/sidecar/edit subqueries in
    // GRID_SELECT never run over the whole library. Only compare within the
    // current model's space: a re-embed to a new model leaves stale rows of a
    // different dimension, and mixing dimensions in `<=>` would error.
    const items = await many<SearchRow>(
      `WITH ranked AS (
         SELECT cl.asset_id, (cl.embedding <=> $1::vector) AS distance
         FROM asset_clip cl
         JOIN assets a ON a.id = cl.asset_id
         WHERE a.deleted_at IS NULL
           AND a.group_role IS DISTINCT FROM 'companion'
           AND cl.model = $2
         ORDER BY cl.embedding <=> $1::vector
         LIMIT $3
       )
       SELECT ${GRID_SELECT}, ranked.distance
       ${GRID_FROM}
       JOIN ranked ON ranked.asset_id = a.id
       ORDER BY ranked.distance ASC`,
      [literal, config.ml.clip.model, limit],
    );

    return json({ items, enabled: true, model: config.ml.clip.model });
  } catch (err) {
    return serverError(err);
  }
}
