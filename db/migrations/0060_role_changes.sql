-- Who set an account's role, and how (2026-11-21).
--
-- Since this migration a linked account's role can come from Sésame: the ID
-- token's `role` claim (the person's role in Sésame's app `winnow`) is applied
-- at each Sésame sign-in (lib/sesameRole.ts). Two writers of one column need a
-- trail, so the Users page can say « set by Sésame » or « set here by X »,
-- and so a claim that was REFUSED (it would have demoted the last active
-- admin) is not silent.
--
--   source = 'admin'  : an admin changed it on the Users page (actor_id);
--   source = 'sesame' : a Sésame sign-in carried the role (actor_id = the
--                       person signing in);
--   kept = 'last_admin' : the claim asked for to_role but was NOT applied,
--                       because the account was the last active admin.
-- Nothing reads this to decide a permission: users.role stays the one truth.
CREATE TABLE role_changes (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_role  TEXT NOT NULL,
  to_role    TEXT NOT NULL CHECK (to_role IN ('admin', 'editor', 'viewer')),
  source     TEXT NOT NULL CHECK (source IN ('admin', 'sesame')),
  actor_id   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  kept       TEXT CHECK (kept IN ('last_admin')),
  at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX role_changes_user_at_idx ON role_changes (user_id, at DESC);
