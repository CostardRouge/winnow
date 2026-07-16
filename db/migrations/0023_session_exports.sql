-- Associate export jobs with the session they were launched from, and keep a
-- lightweight per-session export history that survives the job's deletion.
--
-- Context: a session export stores `{ session_id, verdict: 'pick' }` in the job's
-- filter_query, so the link was only recoverable by joining through the copied
-- assets. Two explicit fields make it cheap and durable:
--
-- 1. export_jobs.session_id — the session an export was launched from (NULL for
--    gallery/ad-hoc exports whose filter spans sessions). ON DELETE SET NULL so
--    deleting the session never blocks on its export history. Drives the live
--    "export in progress" badge: a session with a queued/running job here is
--    still working, so it stays visible in the Incoming list even once ignored.
--
-- 2. sessions.export_count / last_exported_at — bumped by the worker when an
--    export completes. Unlike the job row (deleted once its files are downloaded
--    and removed), this counter PERSISTS, so a session keeps showing "already
--    exported N times, last on <date>" long after the export itself is gone.
ALTER TABLE export_jobs
  ADD COLUMN IF NOT EXISTS session_id BIGINT REFERENCES sessions(id) ON DELETE SET NULL;

-- Partial index: the hot lookups are "this session's exports" and "is any export
-- still in flight", both scoped to jobs that carry a session.
CREATE INDEX IF NOT EXISTS export_jobs_session_idx
  ON export_jobs (session_id) WHERE session_id IS NOT NULL;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS export_count     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_exported_at TIMESTAMPTZ;
