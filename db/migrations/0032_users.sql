-- Application accounts + cookie sessions (replaces the upstream-only
-- Traefik basic-auth with real per-user identity).
--
--   users          : local accounts. Passwords are scrypt-hashed app-side
--                    (cf. lib/auth.ts) — never stored in clear.
--   auth_sessions  : one row per logged-in browser. The cookie holds a random
--                    token; only its SHA-256 is stored, so a DB leak does not
--                    leak usable session cookies. Expired rows are pruned
--                    opportunistically on login (no cron needed).
--
-- Roles (single shared library, per-user permissions):
--   viewer  : browse everything, change nothing.
--   editor  : viewer + cull (ratings/tags/trash), import, export, geotag.
--   admin   : editor + volumes/settings/scan/pipeline/purge + user management.
CREATE TABLE IF NOT EXISTS users (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,          -- stored lowercase, [a-z0-9._-]
  display_name  TEXT,
  password_hash TEXT NOT NULL,                 -- scrypt$N$r$p$salt$hash
  role          TEXT NOT NULL DEFAULT 'viewer'
                CHECK (role IN ('admin', 'editor', 'viewer')),
  disabled      BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash   TEXT PRIMARY KEY,               -- sha256(cookie token), hex
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_agent   TEXT
);

CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions (user_id);
CREATE INDEX IF NOT EXISTS auth_sessions_expires_idx ON auth_sessions (expires_at);

-- Attribution: record WHO culled / exported, now that there is an identity.
-- Nullable (history predates users; a deleted user leaves the work in place).
ALTER TABLE ratings
  ADD COLUMN IF NOT EXISTS rated_by BIGINT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE export_jobs
  ADD COLUMN IF NOT EXISTS created_by BIGINT REFERENCES users(id) ON DELETE SET NULL;
