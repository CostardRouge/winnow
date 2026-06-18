// Construction de filtres SQL partagée entre la grille de tri et les exports.
// Les requêtes joignent toujours `assets a` LEFT JOIN `ratings r`.
import { z } from "zod";

export const FilterSchema = z
  .object({
    session_id: z.coerce.number().int().optional(),
    verdict: z.enum(["pick", "reject", "unrated"]).optional(),
    star_min: z.coerce.number().int().min(0).max(5).optional(),
    media_type: z.enum(["photo", "video"]).optional(),
    device: z.string().optional(),
    processing_state: z
      .enum(["ignored", "unprocessed", "triaged", "exported"])
      .optional(),
    has_gps: z.coerce.boolean().optional(),
  })
  .strip();

export type AssetFilter = z.infer<typeof FilterSchema>;

export function buildFilter(
  filter: AssetFilter,
  startIdx = 1,
): { conditions: string[]; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let i = startIdx;

  if (filter.session_id != null) {
    conditions.push(`a.session_id = $${i++}`);
    params.push(filter.session_id);
  }
  if (filter.verdict != null) {
    if (filter.verdict === "unrated") {
      conditions.push(`COALESCE(r.verdict, 'unrated') = 'unrated'`);
    } else {
      conditions.push(`r.verdict = $${i++}`);
      params.push(filter.verdict);
    }
  }
  if (filter.star_min != null) {
    conditions.push(`COALESCE(r.star, 0) >= $${i++}`);
    params.push(filter.star_min);
  }
  if (filter.media_type != null) {
    conditions.push(`a.media_type = $${i++}`);
    params.push(filter.media_type);
  }
  if (filter.device != null) {
    conditions.push(`a.device = $${i++}`);
    params.push(filter.device);
  }
  if (filter.processing_state != null) {
    conditions.push(`a.processing_state = $${i++}`);
    params.push(filter.processing_state);
  }
  if (filter.has_gps) {
    conditions.push(`a.gps IS NOT NULL`);
  }

  return { conditions, params };
}
