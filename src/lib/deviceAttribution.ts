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
// with its provenance (`device_source`, migration 0043) so the next re-index
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
//
// Both patterns below are evaluated TWICE — here by JS, per row, and by
// Postgres' `~*` when the folder aggregate counts how much of a folder each
// signal carries. `.source` is handed to the query as a parameter so the rule
// still lives in exactly one place, which costs one constraint: they must stay
// inside the POSIX ERE subset both engines share. No `\d`, no `\b`, no
// lookaround — spell character classes out, as these do.
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

/** How many media are waiting for a body — the nav badge and the page header.
 *  Scoped to one folder when `sessionId` is given (what an opened card pages
 *  through). */
export async function countUnattributed(sessionId?: number): Promise<number> {
  const row = await one<{ count: number }>(
    `SELECT count(*)::int AS count FROM assets a
      WHERE ${CANDIDATE_SCOPE}
        ${sessionId != null ? "AND a.session_id = $1" : ""}`,
    sessionId != null ? [sessionId] : [],
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

// ------------------------------------------------------------- folders ----
//
// The list is browsed by FOLDER, not by file. One folder is one shoot is, very
// nearly always, one body: 300 rows collapse into 30 cards, each carrying a
// single verb. The per-file list below exists for the one case that needs it —
// a folder that held two cameras — and is fetched only when a card is opened.
// Same shape as the geotag backlog's folder groups (`docs/UNPLACED.md` §7), for
// the same reason: the decision is taken per folder, so the list should be too.
//
// The per-row predicates, spelled once and reused by the aggregate, the score
// expression and the folder apply. `a` is `assets` wherever they land.
const HAS_SIDECAR_SQL = `EXISTS (SELECT 1 FROM asset_sidecars sc
                                  WHERE sc.asset_id = a.id AND sc.kind = 'srt')`;
const HAS_TELEMETRY_SQL = `EXISTS (SELECT 1 FROM asset_sidecars sc
                                    WHERE sc.asset_id = a.id AND sc.kind = 'srt'
                                      AND sc.sample_count > 0)`;
// $1 = FILENAME_PATTERNS.source, $2 = FOLDER_PATTERNS.source (see the note on
// the constants). `sess` is the joined `sessions` row; `sib` the folder's body.
const NAME_SQL = `a.filename ~* $1`;
const FOLDER_SQL = `sess.source_path ~* $2`;
const SIBLING_SQL = `sib.device IS NOT NULL`;

// The vote, as one arithmetic expression, with the weights interpolated from
// SIGNAL_WEIGHTS so the two engines can never disagree about them. Kept beside
// scoreCandidate() deliberately: if you change one, the diff shows the other.
//
// The sibling term is a parameter rather than a fixed expression because the
// two callers know it differently: the folder aggregate joins `sib` and reads
// it per row, while the folder apply has no such join — there the folder's
// sibling is one boolean, already resolved, passed in.
const scoreSql = (sibling: string) => `(
    CASE WHEN ${HAS_TELEMETRY_SQL} THEN ${SIGNAL_WEIGHTS.telemetry} ELSE 0 END
  + CASE WHEN ${HAS_SIDECAR_SQL}   THEN ${SIGNAL_WEIGHTS.sidecar}   ELSE 0 END
  + CASE WHEN ${NAME_SQL}          THEN ${SIGNAL_WEIGHTS.filename}  ELSE 0 END
  + CASE WHEN ${sibling}           THEN ${SIGNAL_WEIGHTS.sibling}   ELSE 0 END
  + CASE WHEN ${FOLDER_SQL}        THEN ${SIGNAL_WEIGHTS.folder}    ELSE 0 END
)`;
const SCORE_SQL = scoreSql(SIBLING_SQL);

/** A thumbnail the card's strip draws — the same shape Unplaced's cards use. */
export type DeviceSample = {
  id: number;
  ext: string;
  media_type: "photo" | "video";
};

/** One folder with media waiting for a body: a card on the Devices page. */
export type DeviceFolder = {
  session_id: number;
  name: string;
  source_path: string;
  /** Media in this folder carrying no body — what the card's verb acts on. */
  total: number;
  photos: number;
  videos: number;
  /** How many of them the vote is confident about (score >= CONFIDENT_SCORE). */
  confident: number;
  first_capture: string | null;
  last_capture: string | null;
  /** The signals carried by MORE THAN HALF the folder — what the card prints.
   *  A signal two files out of 129 carry says nothing about the folder. */
  signals: DeviceSignal[];
  suggested_device: string | null;
  suggested_camera_model: string | null;
  sample: DeviceSample[];
};

type FolderRow = {
  session_id: number;
  name: string;
  source_path: string;
  total: number;
  photos: number;
  videos: number;
  confident: number;
  first_capture: string | null;
  last_capture: string | null;
  n_telemetry: number;
  n_sidecar: number;
  n_filename: number;
  n_sibling: number;
  n_folder: number;
  suggested_device: string | null;
  suggested_camera_model: string | null;
  sample: DeviceSample[] | null;
};

/** How folders are ordered on the page. */
export type FolderSort = "size" | "recent";

/**
 * Every folder holding unattributed media, with its aggregate evidence.
 *
 * One scan. The per-signal counts are what let the card say "flight log" only
 * when the folder really is flight logs, and the confident count is what the
 * "confident only" actions target. `sample` is the four newest thumbnails, cut
 * server-side — a card never loads a folder to draw four tiles.
 */
export async function listFolders(
  opts: { sort?: FolderSort } = {},
): Promise<DeviceFolder[]> {
  const order =
    opts.sort === "recent"
      ? "ORDER BY last_capture DESC NULLS LAST, session_id DESC"
      : "ORDER BY total DESC, last_capture DESC NULLS LAST";

  const rows = await many<FolderRow>(
    `WITH sib AS (
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
          GROUP BY a.session_id, a.device
       ) ranked
        WHERE rn = 1
     ),
     cand AS (
       SELECT a.id, a.session_id, a.ext, a.media_type, a.captured_at,
              sess.name                AS name,
              sess.source_path         AS source_path,
              sib.device               AS suggested_device,
              sib.camera_model         AS suggested_camera_model,
              ${HAS_TELEMETRY_SQL}     AS has_telemetry,
              ${HAS_SIDECAR_SQL}       AS has_sidecar,
              ${NAME_SQL}              AS has_name,
              ${SIBLING_SQL}           AS has_sibling,
              ${FOLDER_SQL}            AS has_folder,
              ${SCORE_SQL}             AS score
         FROM assets a
         JOIN sessions sess ON sess.id = a.session_id
         LEFT JOIN sib ON sib.session_id = a.session_id
        WHERE ${CANDIDATE_SCOPE}
     )
     SELECT c.session_id, c.name, c.source_path,
            count(*)::int                                            AS total,
            count(*) FILTER (WHERE c.media_type = 'photo')::int       AS photos,
            count(*) FILTER (WHERE c.media_type = 'video')::int       AS videos,
            count(*) FILTER (WHERE c.score >= ${CONFIDENT_SCORE})::int AS confident,
            min(c.captured_at)                                       AS first_capture,
            max(c.captured_at)                                       AS last_capture,
            count(*) FILTER (WHERE c.has_telemetry)::int              AS n_telemetry,
            count(*) FILTER (WHERE c.has_sidecar)::int                AS n_sidecar,
            count(*) FILTER (WHERE c.has_name)::int                   AS n_filename,
            count(*) FILTER (WHERE c.has_sibling)::int                AS n_sibling,
            count(*) FILTER (WHERE c.has_folder)::int                 AS n_folder,
            max(c.suggested_device)                                  AS suggested_device,
            max(c.suggested_camera_model)                            AS suggested_camera_model,
            (SELECT json_agg(s)
               FROM (SELECT d.id, d.ext, d.media_type
                       FROM cand d
                      WHERE d.session_id = c.session_id
                      ORDER BY d.captured_at DESC NULLS LAST, d.id DESC
                      LIMIT 4) s)                                    AS sample
       FROM cand c
      GROUP BY c.session_id, c.name, c.source_path
      ${order}`,
    [FILENAME_PATTERNS.source, FOLDER_PATTERNS.source],
  );

  return rows.map((r) => {
    const half = r.total / 2;
    const counts: [DeviceSignal, number][] = [
      ["telemetry", r.n_telemetry],
      ["sidecar", r.n_sidecar],
      ["filename", r.n_filename],
      ["sibling", r.n_sibling],
      ["folder", r.n_folder],
    ];
    return {
      session_id: r.session_id,
      name: r.name,
      source_path: r.source_path,
      total: r.total,
      photos: r.photos,
      videos: r.videos,
      confident: r.confident,
      first_capture: r.first_capture,
      last_capture: r.last_capture,
      signals: counts.filter(([, n]) => n > half).map(([s]) => s),
      suggested_device: r.suggested_device,
      suggested_camera_model: r.suggested_camera_model,
      sample: r.sample ?? [],
    };
  });
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
  opts: { sessionId?: number; limit?: number; offset?: number } = {},
): Promise<{ items: DeviceCandidate[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 1000);
  const offset = Math.max(opts.offset ?? 0, 0);
  const params: unknown[] = [];
  let where = "";
  if (opts.sessionId != null) {
    params.push(opts.sessionId);
    where = `AND a.session_id = $${params.length}`;
  }
  params.push(limit, offset);
  const rows = await candidateRows({
    where,
    tail: `ORDER BY c.captured_at DESC NULLS LAST, c.id DESC
           LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  });
  return {
    items: rows.map(toCandidate),
    total:
      opts.sessionId != null
        ? await countUnattributed(opts.sessionId)
        : await countUnattributed(),
  };
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
  const rows = await candidateRows({
    where: "AND a.id = ANY($1)",
    tail: "ORDER BY c.captured_at DESC NULLS LAST",
    params: [ids],
  });
  return rows.map(toCandidate);
}

// Shared body of the two lookups above. `where` is an extra predicate inside
// the candidate CTE (where the table is `a`); `tail` is the ORDER/LIMIT clause
// after the outer SELECT (where it is `c`). Both carry their own placeholders,
// numbered by the caller against one `params` array.
async function candidateRows(opts: {
  where?: string;
  tail: string;
  params: unknown[];
}): Promise<CandidateRow[]> {
  const { where: extra = "", tail: order, params } = opts;
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

/**
 * Attribute a WHOLE folder in one statement — the page's primary verb.
 *
 * Deliberately not "read the ids, then apply them": a 129-clip folder would
 * mean shipping 129 numbers to the browser and back to write one value, and the
 * set could have changed in between. The selection is expressed as a predicate
 * instead, evaluated at write time, so what gets the body is exactly what the
 * card said it would — the folder's unattributed media, optionally only those
 * the vote is confident about.
 *
 * `device` given → that body, `device_source = 'manual'`. Omitted → the
 * folder's own suggestion, `'derived'`; a folder with no suggestion writes
 * nothing and says so rather than guessing.
 */
export async function applyFolder(opts: {
  sessionId: number;
  /** Only attribute media scoring at least this much (the card's "confident
   *  only" action passes CONFIDENT_SCORE). */
  minScore?: number;
  device?: string;
  cameraModel?: string | null;
}): Promise<ApplyResult> {
  const pending = await countUnattributed(opts.sessionId);

  // The folder's own body, always looked up: it names the device in suggestion
  // mode, AND it is the sibling term of the score in both modes — a folder that
  // has one gives every medium in it those 3 points whichever body is written.
  const sib = await one<{ device: string; camera_model: string | null }>(
    `SELECT a.device,
            mode() WITHIN GROUP (ORDER BY a.camera_model) AS camera_model
       FROM assets a
      WHERE a.session_id = $1 AND a.deleted_at IS NULL
        AND a.device IS NOT NULL AND a.device <> ''
      GROUP BY a.device
      ORDER BY count(*) DESC, a.device
      LIMIT 1`,
    [opts.sessionId],
  );

  const device = opts.device ?? sib?.device;
  if (!device) return { updated: 0, skipped: pending };
  const cameraModel = opts.device
    ? (opts.cameraModel ?? null)
    : (sib?.camera_model ?? null);

  // $1 filename pattern, $2 folder pattern — the score expression's own
  // placeholders, so they keep those numbers here; the rest follow.
  const res = await q(
    `UPDATE assets a
        SET device = $4, camera_model = COALESCE(a.camera_model, $5),
            device_source = $6, updated_at = now()
       FROM sessions sess
      WHERE sess.id = a.session_id
        AND a.session_id = $3
        AND ${CANDIDATE_SCOPE}
        AND ${scoreSql("$8::boolean")} >= $7`,
    [
      FILENAME_PATTERNS.source,
      FOLDER_PATTERNS.source,
      opts.sessionId,
      device,
      cameraModel,
      opts.device ? "manual" : "derived",
      opts.minScore ?? 0,
      sib != null,
    ],
  );
  const updated = res.rowCount ?? 0;
  return { updated, skipped: Math.max(0, pending - updated) };
}
