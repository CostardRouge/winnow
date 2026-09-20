-- Binary blobs a client app keeps here, beside its documents (0041), cf.
-- api/apps/[app]/files/*.
--
-- Why a second bucket rather than more JSON: Atelier's purchased LUT packs
-- (its docs/lut-packs.md) are 1.5-2 MB per look and 40 MB per pack, which no
-- 1 MiB JSON document can hold and which base64 would inflate by a third.
-- The document bucket keeps the pack's INDEX — names, the tree, what is
-- hidden — and this table keeps the lattices it names.
--
-- Content-addressed: the id IS the SHA-256 of the bytes, checked by the route
-- before anything is written, so a re-upload of the same file is a no-op and a
-- client can ask "do you already hold this?" without sending 40 MB. Rows are
-- PER USER even for identical bytes: sharing one row across accounts would
-- reveal that somebody else holds the same file.
--
-- Ownership is a COLUMN, exactly as in 0041: every query carries
-- `AND user_id = $me`, and a row that is not the caller's answers 404, never
-- 403. A viewer owns its files as it owns its trips (lib/authz.ts lists
-- /api/apps as self-service).
--
-- The BYTES live in the storage driver (lib/storage), under
-- `app-files/<user_id>/<app>/<sha256>` — the same disk-or-S3 abstraction the
-- derivatives use, so an instance on MinIO stores them there with no code
-- change. This table is the index and the quota ledger: it says what exists,
-- how big it is, and who owns it.
--
-- Retention (docs/memory/database.md asks every new table to say): rows exist
-- only by the owner's explicit gestures (upload, delete) and go with the user
-- (ON DELETE CASCADE). Deleting a user leaves its blobs on disk, which is why
-- the route deletes bytes before the row and why a future janitor can find
-- orphans by listing the prefix against this table. Per-file and per-user
-- caps are enforced by the route (lib/appFiles.ts).

CREATE TABLE IF NOT EXISTS app_files (
  app        TEXT    NOT NULL,   -- 'atelier'; opaque to Winnow
  id         TEXT    NOT NULL,   -- lowercase hex SHA-256 of the bytes
  user_id    BIGINT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bytes      BIGINT  NOT NULL,   -- what the blob weighs, for the quota
  media_type TEXT    NOT NULL,   -- as the client declared it; served back verbatim
  storage_key TEXT   NOT NULL,   -- where lib/storage put it
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (app, id, user_id)
);

-- The two questions asked: "what do I hold for this app" (the sync's first
-- call, and the quota sum) and "do you have this hash" (the primary key).
CREATE INDEX IF NOT EXISTS app_files_owner_idx
  ON app_files (user_id, app, created_at DESC);
