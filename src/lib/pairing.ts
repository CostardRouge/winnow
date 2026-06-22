// Media pairing — two files for one capture tied into one `asset_groups` row so
// the app counts, displays, rates and exports the pair as a single logical media
// (cf. migrations 0013 / 0014, §Phase 1). Two kinds:
//
//   raw_jpeg   — cameras that shoot RAW+JPEG, sharing a basename (Sony A7C II →
//                DSC00123.ARW + .HIF, DJI → DJI_0001.DNG + .JPG). The direct
//                (JPEG/HEIF) file is `primary`; the RAW is the `companion`.
//   live_photo — iPhone Live Photos (still + .mov), linked by Apple's Content
//                Identifier. The still is `primary`; the .mov is the `companion`
//                (see reconcileLivePhotosForSession below).
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

// iPhone Live Photos: a still and its companion .mov written for one capture,
// linked by Apple's Content Identifier (the `content_id` column, extracted from
// EXIF/QuickTime — cf. lib/extract.ts). We tie them into one `asset_groups` row
// of kind 'live_photo' so the app counts, displays, rates and exports the pair
// as a single logical media. The still is the displayed `primary` (and the
// export keeper); the .mov is the `companion` — the motion reachable from the
// viewer's segmented toggle.
//
// Runs after RAW+JPEG pairing on each scan, and is idempotent: a pair is only
// created when a content_id is shared by EXACTLY one photo and one video and
// NEITHER is grouped yet, so the .mov can arrive in a later scan and still be
// paired without disturbing an existing group. Matching on the UUID (not the
// basename) keeps it robust to renamed exports and avoids ever pairing two
// unrelated files that merely share a name.
export async function reconcileLivePhotosForSession(
  sessionId: number,
): Promise<number> {
  const pairs = await many<{ photo_id: number; video_id: number }>(
    `WITH media AS (
       SELECT id, group_id, media_type, content_id
       FROM assets
       WHERE session_id = $1
         AND content_id IS NOT NULL AND content_id <> ''
         AND media_type IN ('photo', 'video')
         AND deleted_at IS NULL
     )
     SELECT (array_agg(id) FILTER (WHERE media_type = 'photo'))[1] AS photo_id,
            (array_agg(id) FILTER (WHERE media_type = 'video'))[1] AS video_id
     FROM media
     GROUP BY content_id
     HAVING count(*) FILTER (WHERE media_type = 'photo') = 1
        AND count(*) FILTER (WHERE media_type = 'video') = 1
        AND bool_and(group_id IS NULL)`,
    [sessionId],
  );

  let created = 0;
  for (const { photo_id, video_id } of pairs) {
    // Three statements (not a CTE) so a transient failure on one pair never
    // aborts the whole session. The still is the keeper → 'primary'.
    const { rows } = await q<{ id: number }>(
      `INSERT INTO asset_groups (session_id, kind)
       VALUES ($1, 'live_photo') RETURNING id`,
      [sessionId],
    );
    const gid = rows[0].id;
    await q(
      `UPDATE assets SET group_id = $1, group_role = 'primary'   WHERE id = $2`,
      [gid, photo_id],
    );
    await q(
      `UPDATE assets SET group_id = $1, group_role = 'companion' WHERE id = $2`,
      [gid, video_id],
    );
    created++;
  }
  return created;
}

// SQL CTE expanding a set of asset ids to include their RAW+JPEG group
// companions, so an action applied to one file (rating, soft-delete) cascades
// to the whole pair — the picking unit, per the Photo Mechanic model. `param`
// is the positional placeholder carrying the input ids as a bigint[] (e.g.
// "$1"). Defines a `target_ids(id)` CTE; compose it as the first WITH binding.
export function groupExpandCTE(param: string): string {
  return `target_ids AS (
    SELECT a.id
    FROM assets a
    WHERE a.id = ANY(${param}::bigint[])
       OR a.group_id IN (
         SELECT group_id FROM assets
         WHERE id = ANY(${param}::bigint[]) AND group_id IS NOT NULL
       )
  )`;
}
