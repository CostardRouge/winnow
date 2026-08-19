-- One-time cleanup of the face orphans left by history (§ People follow-up).
--
-- Purge didn't always reap `asset_faces` (cf. docs/ARCHITECTURE-REVIEW R3):
-- assets purged before that fix kept their face rows — embeddings whose
-- derivative is gone forever, so they can never be re-cropped or re-verified.
-- Those stale rows also kept their (unnamed) people alive: lib/people's
-- pruneEmptyPeople only deletes a person with NO faces at all, and nothing
-- re-ran it after a purge or a session delete anyway. The visible symptom:
-- ghost stacks with a great match percentage in the merge suggestions whose
-- profile shows no media at all.
--
-- Going forward the code keeps this state from recurring (purge/session
-- delete/zero-face re-analysis all prune now, and suggestions require a live
-- face); this migration retroactively clears what already accumulated.

-- Faces of purged assets: the bytes and derivatives are gone, so these rows
-- are unusable everywhere (every read joins on a live, unpurged asset).
DELETE FROM asset_faces f
 USING assets a
 WHERE a.id = f.asset_id
   AND a.purged_at IS NOT NULL;

-- Same era, same reason: CLIP embeddings of purged assets tax the flat scan
-- for rows that can never be shown. The table is optional (pgvector — cf.
-- 0030), so guard rather than fail the whole run where it doesn't exist.
DO $$
BEGIN
  IF to_regclass('asset_clip') IS NOT NULL THEN
    DELETE FROM asset_clip c
     USING assets a
     WHERE a.id = c.asset_id
       AND a.purged_at IS NOT NULL;
  END IF;
END $$;

-- Unnamed people left with no faces at all — same rule as pruneEmptyPeople:
-- a NAME is user data and is kept even at zero faces (the centroid lets a
-- re-analyzed library re-attach to it); unnamed empty stacks are pure noise.
DELETE FROM people p
 WHERE p.name IS NULL
   AND NOT EXISTS (SELECT 1 FROM asset_faces f WHERE f.person_id = p.id);
