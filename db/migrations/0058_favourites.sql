-- Favourites: a binary "show this one" mark, beside the cull and not part of it
-- (docs/FAVOURITES.md).
--
-- Why a table of its own and not a column on `ratings`: a rating is the CULL —
-- verdict, stars, colour — and the Gallery has curation off on purpose (a
-- final is accepted as it is). A favourite judges nothing; it says which
-- pictures a recap, a share or a client app should reach for first, and it is
-- the one mark the Gallery allows. Keeping it out of `ratings` keeps that rule
-- readable: nothing that writes here can move a verdict, a star or the
-- session's progress, and nothing that culls can drop a favourite.
--
-- Shared, like a rating: one row per asset, whoever set it (the maintainer's
-- call, 2026-11-06). `favourited_by` / `favourited_via` record the last
-- account and credential that set it, exactly as `rated_by` / `rated_via` do
-- (migrations 0032, 0050) — an agent's favourite stays distinguishable.
--
-- A RAW+JPEG pair or a Live Photo is favourited as one media: the writer
-- (lib/favourites.ts) inserts a row for each live file of the group.
--
-- Retention: a row per favourited media, removed when it is unfavourited or
-- when the asset row itself goes (CASCADE). A trashed asset keeps its row, so
-- a restore gives the favourite back; the live library never lists it meanwhile.

CREATE TABLE IF NOT EXISTS favourites (
  asset_id       BIGINT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  favourited_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  favourited_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  favourited_via TEXT CHECK (favourited_via IN ('session', 'token', 'agent'))
);
