// GET /api/people → every person with their occurrence counts and effective
// cover face, busiest first — the payload behind the /people page and the
// gallery's People facet. Counts follow the app-wide scope rules (live assets
// only): purge deletes face rows and trash hides assets, so a person's numbers
// always match what their filtered grid will actually show.
//
// The cover is resolved HERE, not stored blindly: the chosen cover_face_id dies
// (SET NULL) whenever a re-analysis re-mints the asset's face rows, and even a
// still-set cover may point at a face whose asset is now trashed. Each person
// therefore serves their stored cover only while it is live, falling back to
// their highest-score live face — so a stack never renders coverless.
import { many } from "@/lib/db";
import { config } from "@/lib/config";
import { peopleCoverage } from "@/lib/people";
import { json, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const people = await many(
      `SELECT p.id, p.name,
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
        ORDER BY c.asset_count DESC, p.name ASC NULLS LAST, p.id ASC`,
    );
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
