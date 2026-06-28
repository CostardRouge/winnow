// Finals → sources reconciliation (§8). Links each edited "final" back to the
// original capture it was derived from, so the app can pair before/after — the
// whole point of the feature: spot, at a glance, which RAW a published edit came
// from (and vice-versa).
//
// TOOL-AGNOSTIC by design. The match keys on what every editor (Capture One,
// Photomator, Lightroom, Affinity…) preserves on export — the filename basename
// (sans extension) and the original capture time (DateTimeOriginal) — never on
// Capture One specifics. Both the source RAW and the edited final are already
// indexed as `assets` (finals roots are walked, view-only — cf. lib/volumes.ts),
// so this is a pure DB pass over existing rows: inherently RETROACTIVE across the
// whole library and cheap enough to re-run on demand or after a scan.
//
// Matching rule, per unmatched final F (a non-deleted asset in a `finals` root
// with original_asset_id still NULL):
//   candidates = source-role assets S (kind 'source'/'inbox') of the SAME
//     media_type whose basename equals F's, where the capture time agrees (both
//     present and equal) OR one side carries none.
//   - If ANY candidate also agrees on the DATE, only those "strong" candidates
//     count. This is what disambiguates a filename a camera reuses across cards
//     and years (DSC00123 in 2024 vs 2026): the capture time tells them apart.
//   - Distinct CAPTURES among the kept candidates = count(distinct group-or-id),
//     so the two files of one RAW+JPEG pair count as a single capture.
//   - Exactly one capture → link F to it (the pair's primary, or the standalone
//     file). More than one → ambiguous: left unlinked, never guessed.
//
// Idempotent: only finals with original_asset_id IS NULL are considered, so a
// re-run never disturbs an existing link, and a source or final that arrives in
// a later scan is picked up on the next pass.
import { q, one } from "./db";

export type ReconcileResult = {
  // Finals examined this pass (unmatched, in scope).
  considered: number;
  // Finals newly linked to their source original.
  linked: number;
  // Finals with several plausible captures — left unlinked on purpose.
  ambiguous: number;
  // Finals with no source match at all (renamed, or source not indexed).
  unmatched: number;
};

// The shared CTE chain that resolves, per unmatched final, the single source
// capture it maps to (or flags it ambiguous). `rootClause` optionally scopes the
// finals side to one root; it interpolates a fixed `$1` placeholder, never user
// text. The basename expression mirrors migration 0018's functional index.
function matchCTE(rootScoped: boolean): string {
  const finalScope = rootScoped ? "AND rt.id = $1" : "";
  return `
    finals AS (
      SELECT a.id, a.captured_at, a.media_type,
             lower(regexp_replace(a.filename, '\\.[^.]+$', '')) AS base
      FROM assets a
      JOIN sessions s ON s.id = a.session_id
      JOIN roots rt ON rt.id = s.root_id
      WHERE rt.kind = 'finals'
        AND a.deleted_at IS NULL
        AND a.original_asset_id IS NULL
        ${finalScope}
    ),
    sources AS (
      SELECT a.id, a.captured_at, a.media_type, a.group_id, a.group_role,
             lower(regexp_replace(a.filename, '\\.[^.]+$', '')) AS base
      FROM assets a
      JOIN sessions s ON s.id = a.session_id
      JOIN roots rt ON rt.id = s.root_id
      WHERE rt.kind IN ('source', 'inbox')
        AND a.deleted_at IS NULL
    ),
    cand AS (
      SELECT f.id AS final_id, s.id AS source_id,
             (f.captured_at IS NOT NULL AND s.captured_at IS NOT NULL
                AND f.captured_at = s.captured_at) AS date_match,
             -- Prefer the pair's displayed keeper (primary/standalone) over a RAW
             -- companion, so the link points at the tile the gallery shows.
             (s.group_role IS DISTINCT FROM 'companion') AS prefer_keeper,
             -- One identity per capture: the two files of a RAW+JPEG pair share a
             -- group_id → counted once; a standalone file keys on its own id.
             COALESCE(s.group_id, -s.id) AS capture_key
      FROM finals f
      JOIN sources s
        ON s.base = f.base
       AND s.media_type = f.media_type
       AND (f.captured_at IS NULL OR s.captured_at IS NULL
            OR f.captured_at = s.captured_at)
    ),
    ranked AS (
      SELECT *, bool_or(date_match) OVER (PARTITION BY final_id) AS has_date_match
      FROM cand
    ),
    -- Keep the strong (date-confirmed) candidates when the final has any; fall
    -- back to the name-only candidates otherwise.
    filtered AS (
      SELECT * FROM ranked WHERE date_match = has_date_match
    ),
    resolved AS (
      SELECT final_id,
             count(DISTINCT capture_key) AS n_captures,
             bool_or(date_match) AS via_date,
             (array_agg(source_id ORDER BY prefer_keeper DESC, source_id ASC))[1]
               AS source_id
      FROM filtered
      GROUP BY final_id
    )`;
}

export async function reconcileEdits(
  opts: { rootId?: number } = {},
): Promise<ReconcileResult> {
  const rootScoped = opts.rootId != null;
  const params = rootScoped ? [opts.rootId] : [];
  const cte = matchCTE(rootScoped);

  // Diagnostics first (finals still NULL): how many are matchable / ambiguous.
  const report = await one<{
    considered: number;
    matchable: number;
    ambiguous: number;
  }>(
    `WITH ${cte}
     SELECT
       (SELECT count(*)::int FROM finals)                      AS considered,
       count(*) FILTER (WHERE n_captures = 1)::int             AS matchable,
       count(*) FILTER (WHERE n_captures > 1)::int             AS ambiguous
     FROM resolved`,
    params,
  );

  // Apply the unambiguous links in one statement.
  const upd = await q(
    `WITH ${cte}
     UPDATE assets a
        SET original_asset_id = r.source_id,
            edit_match = CASE WHEN r.via_date THEN 'name_date' ELSE 'name' END,
            updated_at = now()
       FROM resolved r
      WHERE a.id = r.final_id
        AND r.n_captures = 1`,
    params,
  );

  const considered = report?.considered ?? 0;
  const linked = upd.rowCount ?? 0;
  const ambiguous = report?.ambiguous ?? 0;
  return {
    considered,
    linked,
    ambiguous,
    unmatched: Math.max(0, considered - linked - ambiguous),
  };
}
