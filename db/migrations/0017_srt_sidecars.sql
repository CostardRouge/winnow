-- DJI drone subtitle sidecars (.SRT).
--
-- DJI drones write a per-clip telemetry/subtitle file next to every video
-- (DJI_0001.MP4 → DJI_0001.SRT — GPS, altitude, gimbal, timecode…). Like the
-- Sony XML/THM companions (migration 0015), an .SRT is NOT media — never indexed
-- as its own asset, never given derivatives — but it must travel WITH its clip
-- through import, export and purge. Detection (lib/sidecars.ts) keys on the
-- shared base name, exactly as for the existing kinds; here we only widen the
-- stored-kind CHECK to admit 'srt'.
ALTER TABLE asset_sidecars DROP CONSTRAINT IF EXISTS asset_sidecars_kind_check;
ALTER TABLE asset_sidecars ADD CONSTRAINT asset_sidecars_kind_check
  CHECK (kind IN ('xml', 'thm', 'srt'));
