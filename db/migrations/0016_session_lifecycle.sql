-- Rework the session lifecycle (cf. api/sessions, SessionProgress).
--
-- 1. Drop the manual "completed" flag. "Done" is now COMPUTED from verdict
--    coverage — a session is done once every live (non-deleted) media has a
--    verdict — so a hand-set badge is redundant and could disagree with the
--    real state (e.g. stay "completed" after new files land).
--
-- 2. Add a real "skip" verdict. Sift's swipe-up used to leave a media unrated
--    (so it never counted toward completion); it now records a deliberate
--    "neither pick nor reject" decision that DOES count as triaged. This lets a
--    session reach "done" without forcing a pick/reject on every single file.
ALTER TABLE sessions DROP COLUMN IF EXISTS completed;

-- 0001 created the verdict CHECK inline, so Postgres named it <table>_<col>_check.
ALTER TABLE ratings DROP CONSTRAINT IF EXISTS ratings_verdict_check;
ALTER TABLE ratings
  ADD CONSTRAINT ratings_verdict_check
  CHECK (verdict IN ('pick', 'reject', 'skip', 'unrated'));
