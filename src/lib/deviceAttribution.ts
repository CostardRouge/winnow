// Device attribution — giving a body to the media whose file never named one.
//
// `assets.device` (EXIF Make + Model, cf. lib/extract.ts) is the grouping key of
// the entire gear dimension: lib/gear.ts aggregates on it, /api/facets lists it,
// `?device=` filters on it, the viewer prints it. A container that carries
// neither atom is therefore not "badly filtered" — it is outside the dimension.
// The case that motivated this file is the DJI drone: it stamps Make/Model on
// its stills (`DJI FC8482`, prettified by lib/cameraLabels.ts) and nothing at
// all in its MP4s, so half of one aircraft's work never reaches its own card.
//
// This is a REPAIR, not a second metadata pipeline. It never reads an original:
// every signal it weighs is already in Postgres, put there by the indexer. What
// it does is vote, propose, and let a human apply — the attribution is stored
// with its provenance (`device_source`, migration 0042) so the next re-index
// cannot quietly wipe it, exactly as `gps_source = 'manual'` has worked since
// 0031.
//
// Why a VOTE rather than one rule: no single signal is both safe and
// sufficient. A `.SRT` next to a clip is usually a DJI flight log, but `.srt`
// is also the world's most common subtitle extension. A `DJI_` prefix is a
// strong hint that dies the moment a file is renamed. A neighbouring photo that
// *does* carry a body is the best evidence of all — it says WHICH body, not
// merely that there is one — but a folder can hold two cameras. Weighed
// together they separate the obvious from the arguable, and the arguable is
// what the UI hands to the maintainer instead of guessing.
import { many, one, q } from "./db";

// One piece of evidence that a candidate belongs to a given body. Weights are
// deliberately coarse — this ranks a triage list, it does not compute a
// probability, and a tie is resolved by a human looking at the row.
export type DeviceSignal =
  | "telemetry" // a tied .SRT sidecar whose DJI flight log actually parsed
  | "sidecar" // a tied .SRT sidecar, parsed or not
  | "filename" // the maker's own naming scheme (DJI_0001.MP4)
  | "sibling" // another live asset of the SAME folder already has a body
  | "folder"; // the folder path names the gear ("dji drone", "drone")

export const SIGNAL_WEIGHTS: Record<DeviceSignal, number> = {
  // Telemetry that PARSED is the one signal no ordinary subtitle file can fake:
  // lib/srt.ts only reports samples when it found real flight fixes.
  telemetry: 3,
  // A .SRT tied to a clip, on its own, is suggestive rather than conclusive.
  sidecar: 2,
  filename: 2,
  // The strongest *identifying* signal: it names the body rather than merely
  // arguing one exists.
  sibling: 3,
  folder: 1,
};

// At or above this, the vote is considered safe enough to pre-select in the UI.
// Any single signal stays below it on purpose: two independent pieces of
// evidence are the bar. `telemetry` + `sidecar` (5) always travel together and
// clear it, which is the intended headline case — a drone clip with a readable
// flight log is not ambiguous.
export const CONFIDENT_SCORE = 5;

/** A body the library already knows, as the gear dimension spells it. */
export type KnownBody = {
  /** The raw EXIF string — the value every grid filters on. Never a label. */
  device: string;
  /** The bare model, carried along so an attributed row matches its siblings. */
  camera_model: string | null;
  /** How many live media already carry it (busiest first in the picker). */
  count: number;
};

/** A medium carrying no body, with the evidence gathered about it. */
export type DeviceCandidate = {
  id: number;
  filename: string;
  rel_path: string;
  media_type: "photo" | "video";
  captured_at: string | null;
  session_name: string | null;
  signals: DeviceSignal[];
  score: number;
  /** True once `score` clears CONFIDENT_SCORE — the UI pre-selects these. */
  confident: boolean;
  /** The body the vote proposes, or null when nothing named one. */
  suggested_device: string | null;
  suggested_camera_model: string | null;
};

// The raw evidence row, one per candidate. Everything is read from columns the
// indexer already wrote — no file is touched.
type CandidateRow = {
  id: number;
  filename: string;
  rel_path: string;
  media_type: "photo" | "video";
  captured_at: string | null;
  session_name: string | null;
  session_path: string | null;
  has_sidecar: boolean;
  has_telemetry: boolean;
  sibling_device: string | null;
  sibling_camera_model: string | null;
};

// Maker naming schemes that identify a file on its name alone. DJI is the one
// that matters here; the others are listed because the vote is generic and a
// clip named by its camera is evidence whoever made it.
const FILENAME_PATTERNS = /^(dji_|mav_|fpv_)/i;

// Folder names people give gear. Weak by construction (one folder, two
// cameras), which is exactly why it weighs 1.
const FOLDER_PATTERNS = /(^|[^a-z])(dji|drone|mavic|phantom|avata)([^a-z]|$)/i;

/**
 * Weigh one row's evidence. Pure — no DB, no I/O — so the rule is readable in
 * one place and stays testable if this repo ever grows a test runner.
 *
 * The suggestion always comes from the SIBLING body when there is one: it is
 * the only signal that carries an actual identity, and it is also what keeps an
 * attributed clip on the SAME gear card as its neighbouring stills instead of
 * minting a second card for one aircraft. Signals that merely argue "this is a
 * drone" never invent a string — with no sibling, the row is listed with its
 * score and no proposal, and a human picks the body.
 */
export function scoreCandidate(row: CandidateRow): {
  signals: DeviceSignal[];
  score: number;
} {
  const signals: DeviceSignal[] = [];
  if (row.has_telemetry) signals.push("telemetry");
  if (row.has_sidecar) signals.push("sidecar");
  if (FILENAME_PATTERNS.test(row.filename)) signals.push("filename");
  if (row.sibling_device) signals.push("sibling");
  if (row.session_path && FOLDER_PATTERNS.test(row.session_path))
    signals.push("folder");
  const score = signals.reduce((n, s) => n + SIGNAL_WEIGHTS[s], 0);
  return { signals, score };
}

// Live, non-companion media carrying no body. A companion is skipped for the
// same reason every other counter skips it (cf. lib/pairing.ts): it is one half
// of a logical medium, and attributing it separately would double-count the
// pair on the gear card. Purged rows are skipped because there is nothing left
// to attribute.
const CANDIDATE_SCOPE = `
    a.deleted_at IS NULL
    AND a.purged_at IS NULL
    AND a.group_role IS DISTINCT FROM 'companion'
    AND (a.device IS NULL OR a.device = '')`;

/** How many media are waiting for a body — the nav badge and the page header. */
export async function countUnattributed(): Promise<number> {
  const row = await one<{ count: number }>(
    `SELECT count(*)::int AS count FROM assets a WHERE ${CANDIDATE_SCOPE}`,
  );
  return row?.count ?? 0;
}

/**
 * The bodies the library already knows, busiest first. This is the picker's
 * content, and the reason the attribution never hard-codes a camera: the value
 * written is one the gear dimension is ALREADY grouping on, so an attributed
 * clip lands on an existing card rather than beside it.
 */
export async function listKnownBodies(): Promise<KnownBody[]> {
  return many<KnownBody>(
    `SELECT a.device                                        AS device,
            mode() WITHIN GROUP (ORDER BY a.camera_model)   AS camera_model,
            count(*)::int                                   AS count
       FROM assets a
      WHERE a.deleted_at IS NULL
        AND a.device IS NOT NULL AND a.device <> ''
      GROUP BY a.device
      ORDER BY count DESC, a.device`,
  );
}

/**
 * The candidates with their evidence, newest capture first.
 *
 * One query. The sibling lookup is the only non-obvious part: for each folder
 * holding candidates it takes the BUSIEST body already present there, which is
 * what makes "the drone clips in the folder where the drone stills live" resolve
 * to the drone without anyone saying so. A folder with no attributed media at
 * all yields no sibling, and its rows simply come back without a proposal.
 */
export async function listCandidates(
  opts: { limit?: number; offset?: number } = {},
): Promise<{ items: DeviceCandidate[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const offset = Math.max(opts.offset ?? 0, 0);
  const rows = await candidateRows(
    "ORDER BY c.captured_at DESC NULLS LAST, c.id DESC LIMIT $1 OFFSET $2",
    [limit, offset],
  );
  return { items: rows.map(toCandidate), total: await countUnattributed() };
}

/**
 * The same evidence, for a known set of ids — what an apply pass re-derives
 * before writing. Kept separate from the paged listing so a selection made deep
 * in the list is still resolvable: recomputing "the first page again" would
 * silently skip everything below it.
 */
export async function candidatesByIds(
  ids: number[],
): Promise<DeviceCandidate[]> {
  if (!ids.length) return [];
  // The predicate lands INSIDE the candidate CTE, where the table is aliased
  // `a` — not `c`, which only exists in the outer select.
  const rows = await candidateRows("AND a.id = ANY($1)", [ids], "AND");
  return rows.map(toCandidate);
}

// Shared body of the two lookups above. `tail` is appended after the main
// SELECT (an ORDER/LIMIT clause, or an extra predicate when `mode` is "AND", in
// which case it lands inside the candidate CTE instead).
async function candidateRows(
  tail: string,
  params: unknown[],
  mode: "ORDER" | "AND" = "ORDER",
): Promise<CandidateRow[]> {
  const extra = mode === "AND" ? tail : "";
  const order = mode === "AND" ? "ORDER BY c.captured_at DESC NULLS LAST" : tail;
  return many<CandidateRow>(
    `WITH cand AS (
       SELECT a.id, a.filename, a.rel_path, a.media_type, a.captured_at,
              a.session_id
         FROM assets a
        WHERE ${CANDIDATE_SCOPE}
          ${extra}
     ),
     sib AS (
       SELECT session_id, device, camera_model FROM (
         SELECT a.session_id,
                a.device,
                mode() WITHIN GROUP (ORDER BY a.camera_model) AS camera_model,
                row_number() OVER (
                  PARTITION BY a.session_id
                  ORDER BY count(*) DESC, a.device
                ) AS rn
           FROM assets a
          WHERE a.deleted_at IS NULL
            AND a.device IS NOT NULL AND a.device <> ''
            AND a.session_id IN (SELECT session_id FROM cand)
          GROUP BY a.session_id, a.device
       ) ranked
        WHERE rn = 1
     )
     SELECT c.id, c.filename, c.rel_path, c.media_type, c.captured_at,
            s.name                AS session_name,
            s.source_path         AS session_path,
            sib.device            AS sibling_device,
            sib.camera_model      AS sibling_camera_model,
            EXISTS (SELECT 1 FROM asset_sidecars sc
                     WHERE sc.asset_id = c.id AND sc.kind = 'srt')
                                  AS has_sidecar,
            EXISTS (SELECT 1 FROM asset_sidecars sc
                     WHERE sc.asset_id = c.id AND sc.kind = 'srt'
                       AND sc.sample_count > 0)
                                  AS has_telemetry
       FROM cand c
       JOIN sessions s ON s.id = c.session_id
       LEFT JOIN sib ON sib.session_id = c.session_id
      ${order}`,
    params,
  );
}

/** Evidence row → the shape the UI reads. */
function toCandidate(r: CandidateRow): DeviceCandidate {
  const { signals, score } = scoreCandidate(r);
  return {
    id: r.id,
    filename: r.filename,
    rel_path: r.rel_path,
    media_type: r.media_type,
    captured_at: r.captured_at,
    session_name: r.session_name,
    signals,
    score,
    confident: score >= CONFIDENT_SCORE,
    suggested_device: r.sibling_device,
    suggested_camera_model: r.sibling_camera_model,
  };
}

export type ApplyResult = {
  /** Rows that actually received a body. */
  updated: number;
  /** Ids that matched nothing to write — already attributed, trashed, or (in
   *  suggestion mode) carrying no proposal to apply. */
  skipped: number;
};

/**
 * Write a body onto the given media.
 *
 * Two modes, one endpoint:
 *   - `device` given → every id gets that body, `device_source = 'manual'`.
 *     This is the bulk case: select the lot, pick the camera, apply.
 *   - `device` omitted → each id gets ITS OWN suggestion (the busiest body of
 *     its folder), `device_source = 'derived'`. Ids with no suggestion are
 *     counted as skipped rather than guessed at.
 *
 * Only ever fills a HOLE: the UPDATE keeps its `device IS NULL` predicate, so
 * this can never overwrite what a file actually declared. Re-running it is
 * therefore free, and a mistake is undone by picking the right body again —
 * not by this function.
 */
export async function applyAttribution(opts: {
  ids: number[];
  device?: string;
  cameraModel?: string | null;
}): Promise<ApplyResult> {
  const ids = [...new Set(opts.ids)];
  if (!ids.length) return { updated: 0, skipped: 0 };

  if (opts.device) {
    const rows = await many<{ id: number }>(
      `UPDATE assets SET device = $2, camera_model = COALESCE(camera_model, $3),
              device_source = 'manual', updated_at = now()
        WHERE id = ANY($1) AND (device IS NULL OR device = '')
          AND deleted_at IS NULL AND purged_at IS NULL
        RETURNING id`,
      [ids, opts.device, opts.cameraModel ?? null],
    );
    return { updated: rows.length, skipped: ids.length - rows.length };
  }

  // Suggestion mode: recompute each id's proposal rather than trusting one the
  // client sent us. The page may have been open for a while, and the folder's
  // busiest body can have changed under it — the write has to reflect the
  // library as it is now, not as it was rendered.
  const byId = new Map((await candidatesByIds(ids)).map((i) => [i.id, i]));
  let updated = 0;
  for (const id of ids) {
    const hit = byId.get(id);
    if (!hit?.suggested_device) continue;
    const res = await q(
      `UPDATE assets SET device = $2, camera_model = COALESCE(camera_model, $3),
              device_source = 'derived', updated_at = now()
        WHERE id = $1 AND (device IS NULL OR device = '')
          AND deleted_at IS NULL AND purged_at IS NULL`,
      [id, hit.suggested_device, hit.suggested_camera_model],
    );
    updated += res.rowCount ?? 0;
  }
  return { updated, skipped: ids.length - updated };
}
