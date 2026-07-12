-- Image quality + similarity metrics (§ "Faces & text" follow-up). Two more
-- culling signals, computed LOCALLY (sharp, no ML container involved) by the
-- same per-asset analysis job of migration 0021 — the derivative bytes are
-- already in memory there, so both metrics are nearly free:
--
--   1. `sharpness` — variance of the Laplacian of the (greyscale, size-
--      normalized) proxy: the standard focus measure. LOW = flat/blurry,
--      HIGH = crisp edges. A RELATIVE score meant for ranking/filtering within
--      a library ("show me the softest shots of this session"), not an absolute
--      blur verdict. Indexed for the gallery's Sharpness range filter.
--   2. `phash` — a 64-bit perceptual dHash of the proxy, stored as BIGINT.
--      Unlike content_hash (byte-identical dedup, migration 0001/0008), two
--      *near*-identical images (re-export, resize, burst neighbour, small
--      crop) land a few bits apart: Hamming distance ranks "similar photos"
--      (bit_count((phash # $x)::bit(64)), cheap over an 80k library). The
--      btree index also groups EXACT perceptual duplicates directly.

ALTER TABLE assets ADD COLUMN IF NOT EXISTS sharpness REAL;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS phash BIGINT;

-- Range filter (same numeric pattern as iso/file_size in 0003).
CREATE INDEX IF NOT EXISTS assets_sharpness_idx ON assets (sharpness);
-- Exact perceptual-duplicate grouping; the Hamming scan is a seq pass by design.
CREATE INDEX IF NOT EXISTS assets_phash_idx ON assets (phash);
