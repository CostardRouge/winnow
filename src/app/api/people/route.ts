// GET /api/people → every person with their occurrence counts and effective
// cover face — the payload behind the /people page and the merge picker.
// Named people first (a name is the user's claim that the stack matters),
// then busiest first within each group. Counts follow the app-wide scope rules (live assets
// only): purge deletes face rows and trash hides assets, so a person's numbers
// always match what their filtered grid will actually show.
//
// The cover is resolved HERE, not stored blindly: the chosen cover_face_id dies
// (SET NULL) whenever a re-analysis re-mints the asset's face rows, and even a
// still-set cover may point at a face whose asset is now trashed. Each person
// therefore serves their stored cover only while it is live, falling back to
// their highest-score live face — so a stack never renders coverless.
//
// `?similar_to=<person id>` re-ranks the list by centroid proximity to that
// person (cosine, cf. lib/people.ts) and attaches `similarity` per row — the
// merge/move pickers lead with the stacks that LOOK like the one in hand,
// named ones first (a name is worth merging into), then unnamed by similarity.
import { NextRequest } from "next/server";
import { many, one } from "@/lib/db";
import { config } from "@/lib/config";
import { cosineSimilarity, peopleCoverage } from "@/lib/people";
import { json, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const people = await many<{
      id: number;
      name: string | null;
      hidden: boolean;
      face_count: number;
      asset_count: number;
      cover_face_id: number | null;
      similarity?: number;
    }>(
      `SELECT p.id, p.name, p.hidden,
              c.face_count, c.asset_count,
              COALESCE(cov.id, best.id) AS cover_face_id
         FROM people p
        CROSS JOIN LATERAL (
          SELECT count(*)::int                  AS face_count,
                 count(DISTINCT f.asset_id)::int AS asset_count
            FROM asset_faces f
            JOIN assets a ON a.id = f.asset_id AND a.deleted_at IS NULL
           WHERE f.person_id = p.id
        ) c
         LEFT JOIN LATERAL (
          SELECT f.id
            FROM asset_faces f
            JOIN assets a ON a.id = f.asset_id AND a.deleted_at IS NULL
           WHERE f.id = p.cover_face_id AND f.person_id = p.id
        ) cov ON true
         LEFT JOIN LATERAL (
          SELECT f.id
            FROM asset_faces f
            JOIN assets a ON a.id = f.asset_id AND a.deleted_at IS NULL
           WHERE f.person_id = p.id
           ORDER BY f.score DESC, f.id
           LIMIT 1
        ) best ON true
        WHERE c.face_count > 0 OR p.name IS NOT NULL
        ORDER BY (p.name IS NOT NULL) DESC, c.asset_count DESC,
                 p.name ASC NULLS LAST, p.id ASC`,
    );
    // Proximity re-rank: centroids are bounded (hundreds) and live in the
    // people table, so one extra query + a JS cosine per row is cheap. People
    // without a comparable centroid sink to the end in their default order.
    const similarTo = Number.parseInt(
      req.nextUrl.searchParams.get("similar_to") ?? "",
      10,
    );
    if (Number.isFinite(similarTo)) {
      const ref = await one<{ centroid: number[] | null }>(
        `SELECT centroid FROM people WHERE id = $1`,
        [similarTo],
      );
      if (Array.isArray(ref?.centroid) && ref.centroid.length > 0) {
        const centroids = await many<{ id: number; centroid: number[] | null }>(
          `SELECT id, centroid FROM people WHERE centroid IS NOT NULL`,
        );
        const sim = new Map(
          centroids.map((c) => [
            c.id,
            Array.isArray(c.centroid)
              ? cosineSimilarity(ref.centroid as number[], c.centroid)
              : -1,
          ]),
        );
        for (const p of people) {
          const s = sim.get(p.id) ?? -1;
          if (s > -1) p.similarity = s;
        }
        // Named people are the ones worth merging into — lead with them, most
        // similar first, then the unnamed stacks by similarity.
        people.sort(
          (a, b) =>
            (Number(b.name != null) - Number(a.name != null)) ||
            ((b.similarity ?? -1) - (a.similarity ?? -1)),
        );
      }
    }

    // Detected-but-unclustered faces: non-zero on a library analyzed before the
    // People feature existed — the page offers the one-click backfill then.
    const coverage = await peopleCoverage();
    return json({
      people,
      // The display threshold (cf. config ML_PERSON_MIN_FACES): the client
      // tucks unnamed people below it behind "Show all".
      minFaces: config.ml.person.minFaces,
      facesEnabled: config.ml.enabled && config.ml.faces.enabled,
      unassigned: coverage.unassigned,
    });
  } catch (err) {
    return serverError(err);
  }
}
