-- "Mark complete": visual flag on an incoming session. Alters neither the
-- processing, nor the queue, nor the classification; only used to show a
-- "done" badge in the Incoming tab (product decision: a simple flag).
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS completed BOOLEAN NOT NULL DEFAULT false;
