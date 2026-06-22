-- iPhone Live Photos (Phase 1 — data foundations).
--
-- A Live Photo is TWO files written for a single capture: a still (HEIC/JPEG/
-- ProRAW) and a short companion video (.mov) holding the ~3 s of motion. Apple
-- ties the two together with a shared "Content Identifier" (the EXIF/QuickTime
-- `ContentIdentifier` tag, a UUID) and, on the camera roll, they also share a
-- basename (IMG_1234.HEIC + IMG_1234.MOV).
--
-- We reuse the existing `asset_groups` machinery (migration 0013): each file
-- stays one `assets` row; a group ties the pair so the app counts, displays,
-- rates and exports it as ONE logical media. Roles mirror the RAW+JPEG model but
-- the keeper is the OTHER side: the still is the `primary` (shown in grid/viewer,
-- the export keeper), and the .mov is the `companion` — the motion reachable from
-- the viewer toggle. Cf. lib/pairing.ts.

-- 1) Let groups carry the new kind. The original CHECK was an unnamed inline
--    constraint; Postgres names it `asset_groups_kind_check`. Drop-and-recreate
--    under that name is idempotent and keeps the column's allowed set explicit.
ALTER TABLE asset_groups DROP CONSTRAINT IF EXISTS asset_groups_kind_check;
ALTER TABLE asset_groups
  ADD CONSTRAINT asset_groups_kind_check CHECK (kind IN ('raw_jpeg', 'live_photo'));

-- 2) Persist the Apple Content Identifier so scan-time pairing can match a still
--    to its motion by the canonical UUID (lib/pairing.ts), independent of how the
--    files are named. NULL for everything that carries no such tag.
ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS content_id TEXT;

-- Partial index: only Live-Photo members carry a content_id, so the index stays
-- tiny and serves the "find this UUID's other half" lookup at scan time.
CREATE INDEX IF NOT EXISTS assets_content_id_idx
  ON assets (content_id) WHERE content_id IS NOT NULL;

-- 3) Backfill existing libraries. Already-indexed assets have no extracted
--    content_id (an incremental re-scan skips unchanged files), so here we pair
--    by basename: within a session, a single photo + a single video sharing a
--    basename, neither already grouped. New imports are paired by content_id at
--    scan time instead (lib/pairing.ts), which is why re-running this stays a
--    no-op once a pair exists.
DO $$
DECLARE
  rec RECORD;
  gid BIGINT;
BEGIN
  FOR rec IN
    WITH media AS (
      SELECT id, session_id, group_id, media_type,
             lower(regexp_replace(filename, '\.[^.]+$', '')) AS base
      FROM assets
      WHERE media_type IN ('photo', 'video') AND deleted_at IS NULL
    )
    SELECT session_id,
           (array_agg(id) FILTER (WHERE media_type = 'photo'))[1] AS photo_id,
           (array_agg(id) FILTER (WHERE media_type = 'video'))[1] AS video_id
    FROM media
    GROUP BY session_id, base
    HAVING count(*) FILTER (WHERE media_type = 'photo') = 1
       AND count(*) FILTER (WHERE media_type = 'video') = 1
       AND bool_and(group_id IS NULL)
  LOOP
    INSERT INTO asset_groups (session_id, kind)
      VALUES (rec.session_id, 'live_photo')
      RETURNING id INTO gid;
    UPDATE assets SET group_id = gid, group_role = 'primary'   WHERE id = rec.photo_id;
    UPDATE assets SET group_id = gid, group_role = 'companion' WHERE id = rec.video_id;
  END LOOP;
END $$;
