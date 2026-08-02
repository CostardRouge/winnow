-- FK-child and hot-path indexes.
--
-- 1) Unindexed FK children. Every `ON DELETE SET NULL` / CASCADE on a parent
--    row forces Postgres to scan the child table for referencing rows. Deleting
--    a session cascades to each of its assets, and each asset delete scans
--    purge_log, duplicate_hits and bursts in full — quadratic-feeling work that
--    grows with the library and eventually trips the 30 s statement_timeout.
--    Same story for deleting a user (ratings/export_jobs/user_invites) and an
--    export job (exports).
CREATE INDEX IF NOT EXISTS exports_job_idx          ON exports (export_job_id);
CREATE INDEX IF NOT EXISTS purge_log_asset_idx      ON purge_log (asset_id);
CREATE INDEX IF NOT EXISTS duplicate_hits_existing_idx
  ON duplicate_hits (existing_asset_id);
CREATE INDEX IF NOT EXISTS bursts_cover_idx         ON bursts (cover_asset_id);
CREATE INDEX IF NOT EXISTS ratings_rated_by_idx     ON ratings (rated_by);
CREATE INDEX IF NOT EXISTS export_jobs_created_by_idx
  ON export_jobs (created_by);
CREATE INDEX IF NOT EXISTS user_invites_created_by_idx
  ON user_invites (created_by);

-- 2) Session grid keyset. The session view filters `session_id = ? AND
--    deleted_at IS NULL` then keysets on (captured_at, id) (cf. lib/filter.ts
--    buildFilter). Until now the planner had to choose between
--    assets_session_idx (then sort) and assets_live_captured_idx (then filter);
--    on a large session inside a large library both lose. This composite serves
--    the filter AND the order in one scan, and also carries the per-session
--    LATERAL aggregates on /api/sessions. Same partial guard as 0019.
CREATE INDEX IF NOT EXISTS assets_session_captured_idx
  ON assets (session_id, captured_at, id) WHERE deleted_at IS NULL;
