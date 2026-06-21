-- Clean up "[object Object]" placeholders left in the EXIF text columns.
--
-- readMetadata() used to coerce lens / camera / shutter tags with a bare
-- `.toString()`. exiftool-vendored hands a few tags back as plain objects
-- (notably Sony lens fields on video files, which carry no usable LensModel), so
-- that `.toString()` produced the literal string "[object Object]" — which then
-- got stored and surfaced as a junk chip in the filter sidebar. extract.ts now
-- drops such values up front; this backfill scrubs the rows written before the fix.
--
-- These rows keep their original size + mtime, so an incremental re-scan skips
-- them (it won't re-read EXIF unless the file changes). NULL is the correct
-- resting value here: the placeholder never carried real information.

UPDATE assets SET lens = NULL
  WHERE lens LIKE '%[object Object]%';

UPDATE assets SET camera_model = NULL
  WHERE camera_model LIKE '%[object Object]%';

UPDATE assets SET shutter = NULL
  WHERE shutter LIKE '%[object Object]%';

-- `device` is built by joining make + model, so a single bad half can leave a
-- partial string like "Sony [object Object]" — drop the whole value when the
-- placeholder appears anywhere in it.
UPDATE assets SET device = NULL
  WHERE device LIKE '%[object Object]%';
