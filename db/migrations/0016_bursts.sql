-- Burst / bracket stacks (Phase 1 — data foundations).
--
-- A burst (continuous shooting) or an AEB bracket is N DISTINCT frames captured
-- in one quick run: same device, sub-second-to-a-couple-of-seconds apart. Unlike
-- a RAW+JPEG or Live-Photo pair (two files of ONE shot — see asset_groups,
-- migrations 0013/0014), every frame here is a real photo you might keep on its
-- own. So a stack is modelled as a SEPARATE dimension, orthogonal to pairing:
--
--   * `bursts`            — one row per pile (the grouping + a chosen cover frame).
--   * `assets.burst_id`   — which pile a frame belongs to (NULL = standalone).
--   * `assets.burst_seq`  — 1-based order of the frame within its pile.
--
-- Orthogonality matters: a frame can be BOTH a RAW+JPEG pair AND a stack member,
-- because the stack is built over LOGICAL media (the pair's displayed primary —
-- companions are skipped), never over the raw file list. Ratings stay per-asset,
-- so a stack carries no culling state of its own and re-clustering is safe.

CREATE TABLE IF NOT EXISTS bursts (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id     BIGINT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  -- Dominant device of the pile (all members share it — it's a clustering key).
  device         TEXT,
  -- Time span of the pile (first → last frame), for display + audit.
  started_at     TIMESTAMPTZ,
  ended_at       TIMESTAMPTZ,
  -- The frame shown for the collapsed pile in the grid (defaults to the first).
  cover_asset_id BIGINT REFERENCES assets(id) ON DELETE SET NULL,
  member_count   INT NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS burst_id  BIGINT REFERENCES bursts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS burst_seq INT;

CREATE INDEX IF NOT EXISTS bursts_session_idx ON bursts (session_id);
CREATE INDEX IF NOT EXISTS assets_burst_idx   ON assets (burst_id);

-- Backfill existing libraries. Cluster each session's standalone photo frames
-- (skip RAW/Live companions, deleted, undated, already-stacked) chronologically:
-- a new pile starts whenever the gap to the previous frame exceeds the threshold
-- or the device changes; a run of >= min_frames becomes a stack. The thresholds
-- mirror BURST_GAP_SECONDS / BURST_MIN_FRAMES in src/lib/config.ts at the time of
-- writing; new frames are clustered at scan time by lib/bursts.ts (which reads the
-- live config), not retroactively here. Operating only on burst_id IS NULL frames
-- keeps this a no-op once a pile exists, so re-running never churns the grouping.
DO $$
DECLARE
  gap_seconds DOUBLE PRECISION := 1.5;
  min_frames  INT := 3;
  rec RECORD;
  bid BIGINT;
BEGIN
  FOR rec IN
    WITH frames AS (
      SELECT id, session_id, device, captured_at,
             (
               lag(captured_at) OVER w IS NULL
               OR device IS DISTINCT FROM lag(device) OVER w
               OR captured_at - lag(captured_at) OVER w
                  > make_interval(secs => gap_seconds)
             )::int AS brk
      FROM assets
      WHERE media_type = 'photo'
        AND deleted_at IS NULL
        AND group_role IS DISTINCT FROM 'companion'
        AND burst_id IS NULL
        AND captured_at IS NOT NULL
      WINDOW w AS (PARTITION BY session_id ORDER BY captured_at, id)
    ),
    numbered AS (
      SELECT id, session_id, device, captured_at,
             sum(brk) OVER (PARTITION BY session_id ORDER BY captured_at, id)
               AS cluster_no
      FROM frames
    )
    SELECT session_id,
           array_agg(id ORDER BY captured_at, id)               AS ids,
           (array_agg(device ORDER BY captured_at, id))[1]      AS device,
           min(captured_at)                                     AS started_at,
           max(captured_at)                                     AS ended_at,
           count(*)::int                                        AS member_count
    FROM numbered
    GROUP BY session_id, cluster_no
    HAVING count(*) >= min_frames
  LOOP
    INSERT INTO bursts
      (session_id, device, started_at, ended_at, cover_asset_id, member_count)
      VALUES (rec.session_id, rec.device, rec.started_at, rec.ended_at,
              rec.ids[1], rec.member_count)
      RETURNING id INTO bid;
    UPDATE assets a
      SET burst_id = bid, burst_seq = v.seq
      FROM unnest(rec.ids) WITH ORDINALITY AS v(id, seq)
      WHERE a.id = v.id;
  END LOOP;
END $$;
