-- RAW + JPEG pairing (Phase 1 — data foundations).
--
-- Many cameras write two files for a single shot: a RAW "source" and a direct
-- JPEG/HEIF companion (Sony A7C II → .ARW + .HIF, DJI drones → .DNG + .JPG).
-- Each file stays one row in `assets`; an `asset_groups` row ties the two
-- together so the rest of the app can count, display, rate and export the pair
-- as ONE logical media.
--
-- Roles: the direct file (JPEG/HEIF) is the `primary` shown in the grid/viewer
-- (already rendered → instant preview); the RAW is the `companion` — the
-- "source brute" reachable from the viewer's segmented toggle.

CREATE TABLE IF NOT EXISTS asset_groups (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id  BIGINT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'raw_jpeg' CHECK (kind IN ('raw_jpeg')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS group_id   BIGINT REFERENCES asset_groups(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS group_role TEXT CHECK (group_role IN ('primary','companion'));

CREATE INDEX IF NOT EXISTS asset_groups_session_idx ON asset_groups (session_id);
CREATE INDEX IF NOT EXISTS assets_group_idx         ON assets (group_id);

-- Backfill existing libraries. Pair photo assets that share a basename within a
-- session where EXACTLY one is a RAW and one is a direct file, and neither is
-- already grouped (so re-running stays a no-op). The raw-extension list mirrors
-- PHOTO_RAW_EXTS in src/lib/config.ts at the time of writing; new formats added
-- there later are paired at scan time by lib/pairing.ts, not retroactively here.
DO $$
DECLARE
  raw_exts TEXT[] := ARRAY['.arw','.dng','.cr2','.cr3','.nef','.raf','.rw2','.orf'];
  rec      RECORD;
  gid      BIGINT;
BEGIN
  FOR rec IN
    WITH photos AS (
      SELECT id, session_id, group_id,
             lower(regexp_replace(filename, '\.[^.]+$', '')) AS base,
             (lower(ext) = ANY(raw_exts))                    AS is_raw
      FROM assets
      WHERE media_type = 'photo' AND deleted_at IS NULL
    )
    SELECT session_id,
           (array_agg(id) FILTER (WHERE is_raw))[1]     AS raw_id,
           (array_agg(id) FILTER (WHERE NOT is_raw))[1] AS direct_id
    FROM photos
    GROUP BY session_id, base
    HAVING count(*) FILTER (WHERE is_raw) = 1
       AND count(*) FILTER (WHERE NOT is_raw) = 1
       AND bool_and(group_id IS NULL)
  LOOP
    INSERT INTO asset_groups (session_id, kind)
      VALUES (rec.session_id, 'raw_jpeg')
      RETURNING id INTO gid;
    UPDATE assets SET group_id = gid, group_role = 'primary'   WHERE id = rec.direct_id;
    UPDATE assets SET group_id = gid, group_role = 'companion' WHERE id = rec.raw_id;
  END LOOP;
END $$;
