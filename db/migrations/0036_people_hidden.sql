-- People: hidden flag (§ /people follow-up). Some stacks are real people the
-- user simply never wants shown — the wedding photographer, a recurring
-- passer-by. Deleting them is wrong (the clusterer would just re-mint the
-- stack on the next analysis, cf. lib/people.ts); HIDING keeps the person and
-- their centroid (so their faces keep landing on the hidden stack instead of
-- founding visible new ones) while every default surface — the /people shelf
-- tabs, the gallery's People facet, the merge picker — leaves them out. The
-- shelf's Hidden tab is where they reappear, and where the flag comes off.
ALTER TABLE people ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT false;
