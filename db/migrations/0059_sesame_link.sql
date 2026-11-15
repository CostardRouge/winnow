-- An account may sign in through Sésame, the portfolio's identity provider
-- (2026-11-15). The link is Sésame's `sub` for that person, set ONCE from a
-- session already signed in with the password (account menu → Link Sésame),
-- never matched by email: Sésame does not verify addresses, so an email match
-- would hand an account to whoever registered its address there.
ALTER TABLE users ADD COLUMN sesame_sub text UNIQUE;
