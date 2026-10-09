-- Agent provenance: an app token can be minted FOR AN AGENT (an MCP client —
-- Claude driving the library through `src/scripts/mcp.ts`), and a rating
-- records which kind of credential last wrote it.
--
-- Why the mark lives on the TOKEN and not in a request header: a header is
-- what the client says about itself, and a script holding the same key could
-- simply not say it. A token minted as an agent's marks every write made with
-- it, whatever program carries it — the honest default for a question that
-- will be asked later ("which of these picks did I make, and which did the
-- agent make?").
--
-- `ratings.rated_via` sits beside `rated_by` (0032): `rated_by` says WHO
-- (an agent acts as its owner, so it is the owner), `rated_via` says THROUGH
-- WHAT — 'session' (a browser), 'token' (a client app such as Atelier), or
-- 'agent'. It describes the LAST write, like `rated_by`: a human re-rating an
-- agent's pick takes the row back. NULL on every row written before this
-- migration — unknown, not "a browser".
--
-- Retention: no new rows, two columns on existing tables.
ALTER TABLE access_tokens
  ADD COLUMN IF NOT EXISTS agent BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE ratings
  ADD COLUMN IF NOT EXISTS rated_via TEXT
  CHECK (rated_via IN ('session', 'token', 'agent'));
