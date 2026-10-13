-- One-time cleanup of the sidecar rows a moved clip left behind.
--
-- A sidecar (Sony XML/THM, DJI .SRT — cf. lib/sidecars.ts) is tied to its
-- video by sitting in the SAME folder: recordSidecars only ever lists the
-- clip's own directory. When a clip was moved, relink (lib/relink.ts) moved
-- its row onto the new path and recorded the sidecars found there, but the
-- table is keyed on abs_path, so the row of the old location stayed beside the
-- new one. Measured on the maintainer's instance: 263 .SRT rows for 156 drone
-- clips, the 107 extra all pointing at the folders the clips had been moved
-- out of — files that no longer exist there — and listed FIRST by the asset
-- API (ordered by id), so a client asking for a clip's flight log got a 404.
--
-- recordSidecars now drops the rows of a clip that its folder no longer holds,
-- so the state cannot recur; this clears what already accumulated: every row
-- whose directory is not its asset's directory. Rows only — no file is
-- touched, and a re-index of the clip re-records whatever its folder holds.
DELETE FROM asset_sidecars s
 USING assets a
 WHERE a.id = s.asset_id
   AND regexp_replace(s.abs_path, '/[^/]*$', '')
       <> regexp_replace(a.abs_path, '/[^/]*$', '');
