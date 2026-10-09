// The capture-time re-read on real files: no database needed, only the
// exiftool that ships with exiftool-vendored.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeExiftool, readCaptureTimeFromFile } from "./extract";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "../test/fixtures");

after(async () => {
  await closeExiftool();
});

test("a camera clip's date is read although its moov comes after the media data", async () => {
  // Written like a Sony, DJI or iPhone clip: `mdat` first, `moov` (and its
  // CreateDate) last. exiftool -fast2 stops at `mdat` and reads no date.
  const c = await readCaptureTimeFromFile(path.join(fixtures, "camera-moov-last.mp4"));
  assert.ok(c.captured_at, "the clip's CreateDate is read");
  assert.equal(new Date(c.captured_at).toISOString(), "2025-07-07T21:30:18.000Z");
  assert.equal(c.captured_at_source, "exif");
});
