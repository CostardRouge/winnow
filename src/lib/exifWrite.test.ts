// lib/exifWrite.ts's writeGps round-trips a position through a real file, in
// all four hemispheres: written, then read back by the indexer's own reader.
// Until 2026-10-09 it passed unsigned values, from which exiftool-vendored
// derives the N/E refs itself: every pin West or South landed in the original
// mirrored (Brittany in Seine-et-Marne, Australia at 33° N), and the next
// re-index read the mirror back into the database. No database: a scratch
// JPEG made with sharp, and the camera-style MP4 fixture for videos.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { exiftool } from "exiftool-vendored";
import { writeGps } from "./exifWrite";
import { readMetadata } from "./extract";

const dir = mkdtempSync(path.join(tmpdir(), "winnow-gps-"));
after(async () => {
  rmSync(dir, { recursive: true, force: true });
  await exiftool.end();
});

const HEMISPHERES = {
  "north-east (Paris)": { lat: 48.85341, lon: 2.3488 },
  "north-west (Saint-Quay-Portrieux)": { lat: 48.651899, lon: -2.824612 },
  "south-east (Streaky Bay)": { lat: -32.79422, lon: 134.21336 },
  "south-west (Rio)": { lat: -22.9068, lon: -43.1729 },
};

for (const [name, at] of Object.entries(HEMISPHERES)) {
  test(`a photo placed in the ${name} reads back where it was placed`, async () => {
    const f = path.join(dir, `${name.replace(/\W+/g, "-")}.jpg`);
    await sharp({ create: { width: 8, height: 8, channels: 3, background: "#888" } })
      .jpeg()
      .toFile(f);
    await writeGps(f, ".jpg", at);
    const back = (await readMetadata(f)).gps!;
    assert.ok(Math.abs(back.lat - at.lat) < 1e-5, `lat ${back.lat} for ${at.lat}`);
    assert.ok(Math.abs(back.lon - at.lon) < 1e-5, `lon ${back.lon} for ${at.lon}`);
  });
}

test("a clip placed south-west reads back where it was placed", async () => {
  const f = path.join(dir, "clip.mp4");
  copyFileSync(path.join(import.meta.dirname, "../test/fixtures/camera-moov-last.mp4"), f);
  await writeGps(f, ".mp4", HEMISPHERES["south-west (Rio)"]);
  const back = (await readMetadata(f)).gps!;
  assert.ok(back.lat < 0 && back.lon < 0, `${back.lat}, ${back.lon}`);
});
