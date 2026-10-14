// One camera, two names: a body whose files sometimes name their maker and
// sometimes do not.
//
// `assets.device` is the file's Make + Model (lib/extract.ts). Most cameras
// write both in every file; some write the Make in a still and leave it out of
// a video. The Ray-Ban Meta glasses are the case that found it (2026-10-14, the
// instance): their HEIC photos say `Meta AI` + `Ray-Ban Meta Smart Glasses 2`,
// their MOV clips only the Model — so the shelf drew two bodies for one pair of
// glasses (254 photos on one card, 301 videos on the other), and every count,
// filter and ownership claim was split with it.
//
// The join is narrow on purpose. A body is joined only when:
//   - its name IS its model (the file gave a Model and no Make), and
//   - the library's files of that same model spell it ONE way with a Make
//     (`<Make> <Model>`). Two makers claiming one model string is not a join,
//     it is a question — reported, never merged.
// Nothing is guessed: the full name is one some file of the library declares.
// Nothing is written into originals either. What moves:
//   - `device` on every row whose body is the make-less name, whatever its
//     provenance — a hand-pick of that body meant that camera too;
//   - `device_exif` on every row whose FILE said the make-less name: it stays
//     "what the file says", in the spelling the model's other files agree on,
//     so a revert lands on the joined body instead of splitting it again;
//   - the body's ownership row (migration 0053): carried to the full name when
//     that one has none, dropped when it already has its own answer.
//
// Two callers: the indexer at the end of every scan, for the models that scan
// read (so new clips join the stills' body, and a first still with a Make pulls
// in the clips indexed before it), and Settings › Pipeline › Devices, which
// runs it over the whole library and reports what it did. Both run the same
// statements; the result is the same however often it runs.
import { manyWithoutJit, tx } from "./db";
import type {
  JoinReport,
  MakelessPair,
  MakelessQuestion,
  MakelessReport,
} from "./deviceTypes";

// The pairs, from what the index already knows. `$1` narrows to some models
// (the scan's); NULL reads the whole library. The full spellings come from
// FILE declarations only (`device_exif`), never from a body given by hand.
const PAIRS_SQL = `
  WITH makeless AS (
    SELECT a.camera_model AS model,
           count(*) FILTER (WHERE a.deleted_at IS NULL)::int AS media
      FROM assets a
     WHERE a.device IS NOT NULL
       AND a.device = a.camera_model
       -- A name typed by hand (0051) is a person's words, never a model.
       AND a.device_source IS DISTINCT FROM 'named'
       AND ($1::text[] IS NULL OR a.camera_model = ANY($1))
     GROUP BY a.camera_model
    UNION
    -- A row overridden to another body still says the make-less name in
    -- device_exif: it needs the canonical spelling too.
    SELECT a.camera_model_exif, 0
      FROM assets a
     WHERE a.device_exif IS NOT NULL
       AND a.device_exif = a.camera_model_exif
       AND ($1::text[] IS NULL OR a.camera_model_exif = ANY($1))
     GROUP BY a.camera_model_exif
  ),
  models AS (
    SELECT model, max(media)::int AS media FROM makeless GROUP BY model
  ),
  fulls AS (
    SELECT m.model, a.device_exif AS full_name
      FROM models m
      JOIN assets a ON a.camera_model_exif = m.model
     WHERE a.device_exif <> m.model
       AND right(a.device_exif, length(m.model) + 1) = ' ' || m.model
     GROUP BY m.model, a.device_exif
  )
  SELECT m.model, m.media, array_agg(f.full_name ORDER BY f.full_name) AS fulls
    FROM models m
    JOIN fulls f USING (model)
   GROUP BY m.model, m.media
   ORDER BY m.media DESC, m.model`;

/** What a join would do, without doing it. */
export async function findMakelessBodies(models?: string[]): Promise<MakelessReport> {
  if (models && models.length === 0) return { pairs: [], ambiguous: [] };
  const rows = await manyWithoutJit<{ model: string; media: number; fulls: string[] }>(
    PAIRS_SQL,
    [models ?? null],
  );
  const pairs: MakelessPair[] = [];
  const ambiguous: MakelessQuestion[] = [];
  for (const r of rows) {
    if (r.fulls.length === 1) pairs.push({ model: r.model, full: r.fulls[0], media: r.media });
    else ambiguous.push({ model: r.model, fulls: r.fulls, media: r.media });
  }
  return { pairs, ambiguous };
}

/**
 * Join every make-less body to the one full name its model's files declare.
 * `models` narrows the pass (the indexer's: the models one scan read); without
 * it the whole library is read. One transaction: a body is never half-moved.
 */
export async function joinMakelessBodies(models?: string[]): Promise<JoinReport> {
  const found = await findMakelessBodies(models);
  const report: JoinReport = { ...found, moved: 0, ownersMoved: 0, ownersDropped: 0 };
  if (!found.pairs.length) return report;
  const from = found.pairs.map((p) => p.model);
  const to = found.pairs.map((p) => p.full);
  await tx(async (c) => {
    // Trashed rows move too (a restore must not split the body again); the
    // count is of live media, the unit the preview spoke in.
    const moved = await c.query<{ live: boolean }>(
      `UPDATE assets a SET device = p.full_name, updated_at = now()
         FROM unnest($1::text[], $2::text[]) AS p(model, full_name)
        WHERE a.device = p.model
          AND a.device_source IS DISTINCT FROM 'named'
        RETURNING a.deleted_at IS NULL AS live`,
      [from, to],
    );
    report.moved = moved.rows.filter((r) => r.live).length;
    await c.query(
      `UPDATE assets a SET device_exif = p.full_name
         FROM unnest($1::text[], $2::text[]) AS p(model, full_name)
        WHERE a.device_exif = p.model AND a.camera_model_exif = p.model`,
      [from, to],
    );
    // Whose camera: the full name's own answer wins; else the make-less one's
    // answer becomes the full name's.
    const dropped = await c.query(
      `DELETE FROM gear_owners g
        USING unnest($1::text[], $2::text[]) AS p(model, full_name)
        WHERE g.device = p.model
          AND EXISTS (SELECT 1 FROM gear_owners k WHERE k.device = p.full_name)`,
      [from, to],
    );
    report.ownersDropped = dropped.rowCount ?? 0;
    const carried = await c.query(
      `UPDATE gear_owners g SET device = p.full_name, updated_at = now()
         FROM unnest($1::text[], $2::text[]) AS p(model, full_name)
        WHERE g.device = p.model`,
      [from, to],
    );
    report.ownersMoved = carried.rowCount ?? 0;
  });
  return report;
}
