-- Timeline chapter corrections (cf. lib/timeline.ts, api/timeline/*).
--
-- A timeline chapter — "Sydney, 3 → 11 March" — is DERIVED on every request
-- from capture time + reverse-geocoded place, and is never stored: storing the
-- chapters themselves would let the first photo re-indexed inside a period
-- break the cut, and every rescan would have to reconcile two truths. What a
-- human edits is therefore stored as a CORRECTION applied on top of the
-- derivation, the same way ratings stay per-asset so that re-clustering a
-- burst pile is always safe (migration 0029).
--
-- Two corrections exist:
--
--   timeline_chapters  A NAMED SPAN [starts_at, ends_at]. Everything captured
--                      inside it is one chapter, whatever the derivation says
--                      (so it is also the "merge" gesture), carrying the name
--                      and, optionally, a location the human chose. Its two
--                      bounds also act as forced breaks, so a derived run
--                      never straddles the edge of a named span.
--   timeline_breaks    A FORCED SPLIT at one instant: the media at or after
--                      `at` start a new chapter. This is the "split" gesture.
--
-- The location on a span is the CHAPTER's location, not the media's. It never
-- writes GPS onto assets and never arms the EXIF write-back: placing the
-- chapter's GPS-less media there is a separate, explicit gesture that goes
-- through api/assets/geotag and its recap (cf. docs/memory/architecture.md,
-- "A deduced location never writes into an original").
--
-- Retention (docs/memory/database.md asks every new table to say): both
-- tables only ever grow by a human clicking Rename / Split / Merge — counted
-- in tens over the life of a library, deleted from the same UI. There is no
-- automatic writer, so there is no janitor.

CREATE TABLE IF NOT EXISTS timeline_chapters (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  starts_at   TIMESTAMPTZ NOT NULL,
  ends_at     TIMESTAMPTZ NOT NULL,
  -- NULL keeps the derived name (the dominant place); set = renamed.
  name        TEXT,
  -- Human-chosen location of the chapter (autocomplete or hand-picked).
  -- Display + the seed of the optional "place the GPS-less media here"
  -- proposal; never copied onto assets by this table's own machinery.
  place_label TEXT,
  place_lat   DOUBLE PRECISION,
  place_lon   DOUBLE PRECISION,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at >= starts_at),
  CHECK ((place_lat IS NULL) = (place_lon IS NULL)),
  CHECK (place_lat IS NULL OR (place_lat BETWEEN -90 AND 90 AND place_lon BETWEEN -180 AND 180))
);

-- The derivation reads every span on each request (tens of rows) ordered by
-- start; the index keeps that read and the overlap checks trivially cheap.
CREATE INDEX IF NOT EXISTS timeline_chapters_span_idx
  ON timeline_chapters (starts_at, ends_at);

CREATE TABLE IF NOT EXISTS timeline_breaks (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at         TIMESTAMPTZ NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
