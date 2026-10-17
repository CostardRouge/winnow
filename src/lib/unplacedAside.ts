// The media the Unplaced view sets aside from its cards (docs/UNPLACED.md §12):
// what a card's time-based suggestion can only get wrong.
//
//   - NOT A PLACE: screenshots and files saved from another app. Nothing
//     there was shot anywhere; their one gesture is "leave unplaced" (the
//     existing geo-exempt), in bulk, after a look.
//   - GRADED EXPORTS: dated the day they were exported, so their neighbours
//     in time are the grading desk. Their position is their SOURCE clip's,
//     found by name — copied as 'inferred' (never written into the file), and
//     only when exactly one position answers.
//
// The predicates are lib/unplacedSql.ts's; this file lists the media for the
// two dialogs and matches the graded exports to their sources.
import type { PoolClient } from "pg";
import { tx } from "./db";
import { distanceM, UNPLACED_RULES, type AsideMedia, type GradedExport, type UnplacedAsideResponse } from "./unplacedTypes";
import { GRADED, INCOMING_FROM, INCOMING_WHERE, SAVED, SCREENSHOT, TODO } from "./unplacedSql";

// Far above the backlog these lists were built for (91 and 108 on the
// instance) and far below an answer that hurts. Past it the dialog says so.
export const ASIDE_CAP = 5000;

type CandidateRow = {
  id: number;
  session_id: number;
  folder: string;
  filename: string;
  media_type: "photo" | "video";
  captured_at: string | null;
  src_id: number | null;
  src_rel_path: string | null;
  src_captured_at: string | null;
  src_lat: number | null;
  src_lon: number | null;
  src_city: string | null;
  src_country: string | null;
};

// Every unplaced graded export of the Incoming library, each with its source
// clip when exactly one position answers for it.
//
// The name is the key: `<stem>_lut_<YYYYMMDD>.<ext>` was exported from the
// clip named `<stem>` (any extension; a leading "_" dropped on both sides —
// the maintainer's Sony clips sometimes carry one). A stem that starts with a
// date, `20251024_C0223`, may also name a camera clip that kept its own
// short name, `C0223.MP4` — the card numbers restart, so that one must have
// been SHOT on that date too. Several located clips by that name within
// move_m of each other are one answer; further apart they are "ambiguous"
// and nothing is copied.
//
// One pass over the located media, keyed on a lower-cased stem and joined by
// hash on the handful of stems asked: the whole library's names are read
// once, never once per export.
export async function gradedExports(client: PoolClient, limit = ASIDE_CAP + 1): Promise<GradedExport[]> {
  const { rows } = await client.query<CandidateRow>(
    `WITH ex AS (
       SELECT a.id, a.session_id, s.name AS folder, a.filename, a.media_type, a.captured_at,
              regexp_replace(substring(a.filename from '^(.*)_lut_[0-9]{8}\\.[^.]+$'), '^_', '') AS stem
       ${INCOMING_FROM}
       WHERE ${INCOMING_WHERE} AND ${TODO} AND ${GRADED}
       ORDER BY a.captured_at ASC NULLS LAST, a.id ASC
       LIMIT $1
     ),
     k AS (
       SELECT ex.*, lower(stem) AS k1,
              substring(stem from '^([0-9]{8})_') AS day,
              lower(substring(stem from '^[0-9]{8}_(.+)$')) AS k2
       FROM ex
     ),
     src AS (
       SELECT b.id, b.rel_path, b.captured_at, b.capture_date, b.gps_lat, b.gps_lon,
              b.place_city, b.place_country,
              lower(regexp_replace(regexp_replace(b.filename, '\\.[^.]+$', ''), '^_', '')) AS key
       FROM assets b
       WHERE b.deleted_at IS NULL AND b.gps_lat IS NOT NULL
         AND b.filename !~* '_lut_[0-9]{8}\\.'
         AND lower(regexp_replace(regexp_replace(b.filename, '\\.[^.]+$', ''), '^_', ''))
             IN (SELECT k1 FROM k UNION SELECT k2 FROM k WHERE k2 IS NOT NULL)
     )
     SELECT k.id, k.session_id, k.folder, k.filename, k.media_type, k.captured_at,
            src.id AS src_id, src.rel_path AS src_rel_path, src.captured_at AS src_captured_at,
            src.gps_lat AS src_lat, src.gps_lon AS src_lon,
            src.place_city AS src_city, src.place_country AS src_country
     FROM k
     LEFT JOIN src
       ON src.key = k.k1
       OR (src.key = k.k2
           AND (to_char(src.capture_date, 'YYYYMMDD') = k.day
                OR to_char(src.captured_at AT TIME ZONE 'UTC', 'YYYYMMDD') = k.day))
     ORDER BY k.captured_at ASC NULLS LAST, k.id ASC, src.id ASC`,
    [limit],
  );

  const out: GradedExport[] = [];
  const byId = new Map<number, { row: CandidateRow; srcs: CandidateRow[] }>();
  for (const r of rows) {
    let e = byId.get(r.id);
    if (!e) {
      e = { row: r, srcs: [] };
      byId.set(r.id, e);
    }
    if (r.src_id != null) e.srcs.push(r);
  }
  for (const { row, srcs } of byId.values()) {
    const first = srcs[0];
    const agree =
      first != null &&
      srcs.every(
        (x) =>
          distanceM(
            { lat: Number(first.src_lat), lon: Number(first.src_lon) },
            { lat: Number(x.src_lat), lon: Number(x.src_lon) },
          ) <= UNPLACED_RULES.move_m,
      );
    out.push({
      id: Number(row.id),
      session_id: row.session_id,
      folder: row.folder,
      filename: row.filename,
      media_type: row.media_type,
      captured_at: row.captured_at,
      source: agree
        ? {
            id: Number(first.src_id),
            rel_path: first.src_rel_path!,
            captured_at: first.src_captured_at,
            lat: Number(first.src_lat),
            lon: Number(first.src_lon),
            name: first.src_city
              ? first.src_country
                ? `${first.src_city}, ${first.src_country}`
                : first.src_city
              : first.src_country,
          }
        : null,
      reason: agree ? null : first ? "ambiguous" : "none",
    });
  }
  return out;
}

// Both dialogs' lists in one read.
export async function listAside(): Promise<UnplacedAsideResponse> {
  return tx(async (client) => {
    await client.query("SET LOCAL jit = off");
    const { rows: nap } = await client.query<AsideMedia>(
      `SELECT a.id::int AS id, a.session_id, s.name AS folder, a.filename, a.media_type, a.captured_at,
              CASE WHEN ${SCREENSHOT} THEN 'screenshot' ELSE 'saved' END AS kind
       ${INCOMING_FROM}
       WHERE ${INCOMING_WHERE} AND ${TODO}
         AND NOT ${GRADED} AND (${SCREENSHOT} OR ${SAVED})
       ORDER BY kind DESC, a.captured_at ASC NULLS LAST, a.id ASC
       LIMIT $1`,
      [ASIDE_CAP + 1],
    );
    const graded = await gradedExports(client);
    const truncated = nap.length > ASIDE_CAP || graded.length > ASIDE_CAP;
    return {
      not_a_place: nap.slice(0, ASIDE_CAP),
      graded: graded.slice(0, ASIDE_CAP),
      cap: ASIDE_CAP,
      truncated,
    };
  });
}
