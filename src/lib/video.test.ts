// The plain-words cause put ahead of ffmpeg's stderr in a stored derivative error.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ffmpegHint } from "./video";

test("a clip with no readable moov index is called damaged, not left to ffmpeg's words", () => {
  // Verbatim tail of a failure on the instance (an iPhone .MOV cut at 624 MiB).
  const stderr = `[mov,mp4,m4a,3gp,3g2,mj2 @ 0x7ffa390b5000] moov atom not found
/nas-incoming/iphone/photos/2026/june 2026/AIMO8349.MOV: Invalid data found when processing input`;
  assert.match(ffmpegHint(stderr), /^Damaged file: .*copy it again from the source/);
  assert.equal(ffmpegHint("Conversion failed!"), "");
});
