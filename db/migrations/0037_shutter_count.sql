-- Mechanical shutter actuation counter, read from the file's MakerNotes at
-- index time (cf. lib/extract.ts). Sony bodies (and a few other brands) stamp
-- every frame with the body's counter at capture, so max(shutter_count) over a
-- body's indexed frames IS its last known odometer reading — no "find the
-- latest photo" lookup needed. NULL wherever the maker writes no such tag
-- (phones, drones, video files, electronic-shutter-only frames).
ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS shutter_count INTEGER;
