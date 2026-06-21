-- Deduplication audit (review §4).
-- content_hash is a PARTIAL hash (size + first/last 64 KiB; see src/lib/hash.ts).
-- It can in theory produce a FALSE collision: two genuinely distinct files that
-- share the same size and endpoints but differ in between. Previously such a
-- file was silently skipped (res.duplicates++) and never indexed nor traced —
-- a real integrity risk for a photo archive (a distinct shot would vanish).
--
-- Now every detected collision is VERIFIED by a full-content compare, and the
-- outcome recorded here:
--   verified = true   genuine duplicate, dropped (not reprocessed)
--   verified = false  FALSE collision: the file IS indexed (content_hash left
--                     NULL so it escapes the unique index) — never lost
--   verified = NULL   unverifiable (existing file missing/unreadable): kept the
--                     previous conservative behavior (dropped) but now traced
--
-- Upsert by abs_path (like scan_failures): a path re-seen on each incremental
-- scan updates the same row + a hit counter, keeping the table bounded.
CREATE TABLE IF NOT EXISTS duplicate_hits (
  abs_path          TEXT PRIMARY KEY,
  content_hash      TEXT NOT NULL,
  existing_asset_id BIGINT REFERENCES assets(id) ON DELETE SET NULL,
  source            TEXT NOT NULL CHECK (source IN ('index', 'import')),
  verified          BOOLEAN,
  file_size         BIGINT,
  hits              INTEGER NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS duplicate_hits_recent_idx
  ON duplicate_hits (updated_at DESC);
-- False collisions are the integrity-relevant ones worth auditing closely.
CREATE INDEX IF NOT EXISTS duplicate_hits_false_idx
  ON duplicate_hits (updated_at DESC) WHERE verified IS FALSE;
