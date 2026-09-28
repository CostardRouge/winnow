-- App tokens: a credential for a client app that cannot hold Winnow's session
-- cookie. The case that asked for it is Atelier launched from an iPhone's home
-- screen: a standalone web app gets its OWN cookie jar, and signing in on
-- Winnow's /login opens in a different browser context, so the cookie never
-- reaches the app. The client sends `Authorization: Bearer <token>` instead
-- (Atelier's `WinnowAuth { mode: 'token' }` already does).
--
-- A token is a key to ONE person's account, not an account of its own. Every
-- per-user row an app keeps here (app_documents, app_files) is scoped by
-- user_id, so a token that resolved to a separate "application" user would
-- open on an empty bucket: the trip saved from the desktop would not be on the
-- phone. The separation lives in the credential instead (cf. lib/authz.ts):
--
--   * role is a CEILING, never a grant: the request runs as
--     min(owner's current role, this role). 'admin' is not a value — no token
--     can reach settings, volumes, purge, user management or the DB dump;
--   * a token reaches the API only, never a page, and never /api/auth/*
--     beyond reading who it is: it cannot mint tokens, change a password,
--     or turn itself into a session cookie;
--   * disabling the owner kills it (the lookup joins NOT u.disabled), and a
--     role change applies on the next request.
--
-- Only the SHA-256 is stored, like auth_sessions and user_invites: the clear
-- token is shown once at creation and never again. `hint` (its last four
-- characters) is what lets a person match the row to the token they pasted.
--
-- Retention (docs/memory/database.md asks every new table to say): rows exist
-- only by an admin's explicit gesture and die by one (revoke deletes the row)
-- or with the owner (ON DELETE CASCADE). An expired row is refused at lookup
-- and stays listed as "expired" until revoked — tens of rows at most, no
-- automatic writer, so no janitor.
CREATE TABLE IF NOT EXISTS access_tokens (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,            -- sha256(token), hex
  hint         TEXT NOT NULL,                   -- last 4 chars of the token
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,                   -- "Atelier — iPhone"
  role         TEXT NOT NULL DEFAULT 'viewer'
               CHECK (role IN ('viewer', 'editor')),
  created_by   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ,                     -- NULL = no expiry
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS access_tokens_user_idx ON access_tokens (user_id);
-- Deleting a user SET NULLs created_by here; without an index that is a
-- sequential scan per deleted user (the reason 0034 indexed the others).
CREATE INDEX IF NOT EXISTS access_tokens_created_by_idx
  ON access_tokens (created_by);
