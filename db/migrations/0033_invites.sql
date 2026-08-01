-- Invite links: accounts are created WITHOUT a password. The admin hands the
-- new user a one-time /invite/<token> URL (out of band); opening it lets the
-- person choose their own password — which therefore never travels through a
-- chat and is never known to the admin. The same mechanism serves as the
-- password reset ("send a new link" instead of "type a new password").
--
--   * users.password_hash becomes nullable: NULL = no password set yet
--     (pending invite) — such an account cannot sign in.
--   * user_invites: at most ONE live invite per user (re-issuing replaces it).
--     Like auth_sessions, only the SHA-256 of the token is stored, so a DB
--     leak never yields a usable link. Rows die on use (deleted) or expiry.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

CREATE TABLE IF NOT EXISTS user_invites (
  token_hash TEXT PRIMARY KEY,                -- sha256(url token), hex
  user_id    BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
