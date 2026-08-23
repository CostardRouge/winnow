-- Distinguish an exposure bracket (AEB) from a plain continuous-shooting
-- burst inside a burst/bracket pile (cf. migration 0029, lib/bursts.ts).
--
-- Detection is two-tier, checked in this order for each pile at cluster time:
--   1. Explicit signal: any member frame carries a maker's bracket-sequence
--      tag (exiftool's composite BracketShotNumber, which absorbs the
--      per-brand MakerNotes variants the same way ShutterCount does).
--   2. Fallback: the frames' exposure compensation (EV) actually differs
--      across the pile by more than BURST_BRACKET_EV_EPSILON — this is what
--      catches iPhone and DJI drone bracket sequences, which don't stamp the
--      maker-specific tag.
-- Anything that clusters as a pile but matches neither is a plain 'action'
-- burst (continuous shooting). The clustering itself (temporal gap + same
-- device) is unchanged; this only classifies what was already grouped.

ALTER TABLE assets
  -- Exposure bias in EV units read from every photo's EXIF (Sony, iPhone, DJI
  -- all write it) — NULL only when the file carries no such tag at all.
  ADD COLUMN IF NOT EXISTS exposure_compensation NUMERIC,
  -- Maker's explicit bracket-sequence index. IMPORTANT: 0 is the "not
  -- bracketing" value the maker stamps on every ordinary frame it tags at
  -- all, not "shot #0" — callers must test `> 0`, never `IS NOT NULL` alone.
  ADD COLUMN IF NOT EXISTS bracket_shot_number SMALLINT;

ALTER TABLE bursts
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'action'
    CHECK (kind IN ('action', 'bracket'));

CREATE INDEX IF NOT EXISTS bursts_kind_idx ON bursts (kind);

-- No backfill UPDATE here, deliberately: `exposure_compensation` and
-- `bracket_shot_number` are NULL on every already-indexed frame (they didn't
-- exist as columns until this migration), so there is nothing to classify
-- from yet — every existing pile stays 'action' by the DEFAULT above. Values
-- land on a frame only the next time its EXIF is re-read. And because
-- reconcileBurstsForSession only clusters frames with burst_id IS NULL (cf.
-- lib/bursts.ts), an ordinary rescan never revisits an already-formed pile
-- either. So an existing pile only gets reclassified via an explicit
-- restack (the `restackSession` escape hatch) run after its frames have been
-- rescanned — the same two-step already required to pick up a
-- BURST_GAP_SECONDS/BURST_MIN_FRAMES threshold change.
