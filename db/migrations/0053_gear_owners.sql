-- Whose camera is it (cf. lib/gearOwners.ts) — the ownership of a BODY, set by
-- hand on /gear.
--
-- Keyed by the body's `device` string, the gear dimension's grouping key: one
-- row says something about every medium that body shot, so a claim made once
-- on the shelf reaches every grid ("Shot by me") without touching a single
-- asset row. A body with no row is "not sorted" — nothing is assumed.
--
--   owner        'mine'  — the maintainer's, between owned_from and
--                          owned_until (either open: since forever / still);
--                'other' — someone else's: a person of /people (person_id),
--                          else a name typed by hand (owner_name);
--                'none'  — not a camera at all (an app, a laptop webcam).
--   person_id    The person, when /people knows them. ON DELETE SET NULL:
--                owner_name keeps the name the row was given, so deleting a
--                person never un-sorts their cameras.
--   owner_name   The name as typed, or the person's name when it was picked —
--                the fallback the shelf prints once person_id is gone, and the
--                only name when People is off or the person has no stack.
--   owned_from / owned_until
--                The span the body was the maintainer's, by capture DATE,
--                inclusive. "Shot by me" is a medium of a 'mine' body captured
--                inside it; outside it the same body was someone else's (bought
--                second-hand, sold on). Only meaningful for 'mine'.
--
-- Not written into originals, like every body correction (0048, 0051).

CREATE TABLE IF NOT EXISTS gear_owners (
  device       TEXT PRIMARY KEY,
  owner        TEXT NOT NULL CHECK (owner IN ('mine', 'other', 'none')),
  person_id    BIGINT REFERENCES people(id) ON DELETE SET NULL,
  owner_name   TEXT,
  owned_from   DATE,
  owned_until  DATE,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (owned_from IS NULL OR owned_until IS NULL OR owned_from <= owned_until),
  CHECK (owner = 'mine' OR (owned_from IS NULL AND owned_until IS NULL)),
  CHECK (owner = 'other' OR (person_id IS NULL AND owner_name IS NULL))
);
