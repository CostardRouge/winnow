-- An opaque document bucket for a client app (Atelier, first), cf.
-- api/apps/[app]/docs/*. Bridge phase 3 (Atelier's docs/winnow-bridge.md,
-- docs/roadtrip-persistence.md): a Road Trip kept here resumes from another
-- device, Winnow storing JSON it never reads.
--
-- Ownership is a COLUMN, not a role. Every GET on this instance is
-- viewer-visible, so without user_id scoping each trip would be readable by
-- every account on the instance. Every query on these rows carries
-- `AND user_id = $me`, and a row that is not the caller's answers 404 — never
-- 403 — so its existence is not revealed.
--
-- The etag is an opaque revision regenerated on every write. A client sends
-- it back as If-Match; a stale one is refused (412) with the current
-- revision, and the client decides. Last-write-wins with a refusal, not a
-- sync engine: one document, one writer at a time.
--
-- Retention (docs/memory/database.md asks every new table to say): rows
-- exist only by the owner's explicit gestures (create, move, delete) and go
-- with the user (ON DELETE CASCADE). No automatic writer, so no janitor.
-- Documents are tens of KB and a person keeps a handful; the route caps a
-- body at 1 MiB.

CREATE TABLE IF NOT EXISTS app_documents (
  app        TEXT    NOT NULL,   -- 'atelier'; opaque to Winnow
  id         TEXT    NOT NULL,   -- client-minted (a UUID in practice)
  user_id    BIGINT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT    NOT NULL,   -- 'trip' | 'project'; listed by, never read
  version    INTEGER NOT NULL,   -- the client's own document version
  doc        JSONB   NOT NULL,
  etag       TEXT    NOT NULL,   -- opaque revision, regenerated on every write
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (app, id)
);

-- The list is "my documents of one kind, newest first" — one index answers
-- it and the ownership check on a single row alike.
CREATE INDEX IF NOT EXISTS app_documents_owner_idx
  ON app_documents (user_id, app, kind, updated_at DESC);
