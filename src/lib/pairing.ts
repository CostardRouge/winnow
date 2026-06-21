// RAW + JPEG pairing (cf. migration 0013, §Phase 1).
//
// Cameras that shoot RAW+JPEG write two files for one shot, sharing a basename
// (Sony A7C II → DSC00123.ARW + DSC00123.HIF, DJI → DJI_0001.DNG + DJI_0001.JPG).
// We tie them into one `asset_groups` row so the app counts, displays, rates and
// exports the pair as a single logical media. The direct (JPEG/HEIF) file is the
// displayed `primary`; the RAW is the `companion` ("source brute").
//
// This runs after indexing a session and is idempotent: a pair is only created
// when a basename has EXACTLY one RAW and one direct photo and NEITHER is grouped
// yet. The second file of a pair can therefore arrive in a later scan and still
// be paired, without ever disturbing an existing group.
import { q, many } from "./db";
import { PHOTO_RAW_EXTS } from "./config";

const RAW_EXTS = Array.from(PHOTO_RAW_EXTS);

// Reconcile groups for one session; returns the number of new pairs created.
export async function reconcileGroupsForSession(
  sessionId: number,
): Promise<number> {
  const pairs = await many<{ raw_id: number; direct_id: number }>(
    `WITH photos AS (
       SELECT id, group_id,
              lower(regexp_replace(filename, '\\.[^.]+$', '')) AS base,
              (lower(ext) = ANY($2))                           AS is_raw
       FROM assets
       WHERE session_id = $1 AND media_type = 'photo' AND deleted_at IS NULL
     )
     SELECT (array_agg(id) FILTER (WHERE is_raw))[1]     AS raw_id,
            (array_agg(id) FILTER (WHERE NOT is_raw))[1] AS direct_id
     FROM photos
     GROUP BY base
     HAVING count(*) FILTER (WHERE is_raw) = 1
        AND count(*) FILTER (WHERE NOT is_raw) = 1
        AND bool_and(group_id IS NULL)`,
    [sessionId, RAW_EXTS],
  );

  let created = 0;
  for (const { raw_id, direct_id } of pairs) {
    // Allocate the group, then assign roles. Done as three statements rather than
    // a CTE so a transient failure on one pair never aborts the whole session.
    const { rows } = await q<{ id: number }>(
      `INSERT INTO asset_groups (session_id, kind)
       VALUES ($1, 'raw_jpeg') RETURNING id`,
      [sessionId],
    );
    const gid = rows[0].id;
    await q(
      `UPDATE assets SET group_id = $1, group_role = 'primary'   WHERE id = $2`,
      [gid, direct_id],
    );
    await q(
      `UPDATE assets SET group_id = $1, group_role = 'companion' WHERE id = $2`,
      [gid, raw_id],
    );
    created++;
  }
  return created;
}
