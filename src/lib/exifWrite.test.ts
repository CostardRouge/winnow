// lib/exifWrite.ts's writeGps round-trips a position through a real file, in
// all four hemispheres: written, then read back by the indexer's own reader.
// Until 2026-10-09 it passed unsigned values, from which exiftool-vendored
// derives the N/E refs itself: every pin West or South landed in the original
// mirrored (Brittany in Seine-et-Marne, Australia at 33° N), and the next
// re-index read the mirror back into the database.
// And a write killed halfway (audit BE-05, 2026-10-13 on the instance: every
// clip over ~1 GB, killed at 30 s) is settled by the next one instead of
// blocking it — or, killed during the copy-back, of leaving the original half
// rewritten. No database: scratch JPEGs made with sharp, and the camera-style
// MP4 fixture for videos.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { exiftool } from "exiftool-vendored";
import { closeExifWriter, exifWriter, exiftoolTmp, gpsWriteHint, writeGps } from "./exifWrite";
import { readMetadata } from "./extract";

const dir = mkdtempSync(path.join(tmpdir(), "winnow-gps-"));
after(async () => {
  rmSync(dir, { recursive: true, force: true });
  await exiftool.end();
  await closeExifWriter();
});

const jpeg = (f: string) =>
  sharp({ create: { width: 8, height: 8, channels: 3, background: "#888" } }).jpeg().toFile(f);
const readsBack = async (f: string, at: { lat: number; lon: number }) => {
  const back = (await readMetadata(f)).gps!;
  assert.ok(Math.abs(back.lat - at.lat) < 1e-5 && Math.abs(back.lon - at.lon) < 1e-5, `${back.lat}, ${back.lon}`);
};
const LONG_AGO = new Date("2025-12-23T08:01:54Z");

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

test("a write is never cut short: the writer's exiftool has no 30 s limit", () => {
  assert.ok(exifWriter().options.taskTimeoutMillis >= 60 * 60 * 1000);
});

test("the scratch copy of a write killed before the copy-back no longer blocks the next", async () => {
  const f = path.join(dir, "abandoned.jpg");
  await jpeg(f);
  utimesSync(f, LONG_AGO, LONG_AGO); // untouched since: older than its tmp
  writeFileSync(exiftoolTmp(f), Buffer.alloc(4096, 7)); // a copy cut short
  const at = HEMISPHERES["north-east (Paris)"];
  assert.equal(await writeGps(f, ".jpg", at), "written"); // was "Temporary file already exists"
  assert.equal(existsSync(exiftoolTmp(f)), false);
  await readsBack(f, at);
});

test("a copy-back killed halfway is finished from exiftool's own copy", async () => {
  const f = path.join(dir, "interrupted.mp4");
  copyFileSync(path.join(import.meta.dirname, "../test/fixtures/camera-moov-last.mp4"), f);
  const at = HEMISPHERES["south-east (Streaky Bay)"];
  // What exiftool had finished: the tagged file, stamped with the original's dates.
  const done = path.join(dir, "done.mp4");
  copyFileSync(f, done);
  await writeGps(done, ".mp4", at);
  utimesSync(done, LONG_AGO, LONG_AGO);
  const finished = readFileSync(done);
  renameSync(done, exiftoolTmp(f));
  // What the kill left: the start of the new version over the old one, dated now.
  const fd = openSync(f, "r+");
  writeSync(fd, finished, 0, Math.floor(finished.length / 2), 0);
  closeSync(fd);

  assert.equal(await writeGps(f, ".mp4", at), "completed");
  assert.deepEqual(readFileSync(f), finished, "byte for byte what exiftool was writing");
  assert.equal(statSync(f).mtime.getTime(), LONG_AGO.getTime(), "and its own date back");
  assert.equal(existsSync(exiftoolTmp(f)), false);
  await readsBack(f, at);
});

test("a copy that is not this write's is never put over the original", async () => {
  const f = path.join(dir, "foreign.jpg");
  await jpeg(f);
  const other = path.join(dir, "other.jpg");
  copyFileSync(f, other);
  await writeGps(other, ".jpg", HEMISPHERES["north-east (Paris)"]);
  utimesSync(other, LONG_AGO, LONG_AGO);
  renameSync(other, exiftoolTmp(f)); // older than the original: a copy-back "had started"
  const before = readFileSync(f);
  await assert.rejects(writeGps(f, ".jpg", HEMISPHERES["south-west (Rio)"]), /Nothing was touched/);
  assert.deepEqual(readFileSync(f), before);
  assert.equal(existsSync(exiftoolTmp(f)), true);
});

test("a damaged original is said in plain words", () => {
  // exiftool's refusal for the two cut ARWs of the instance (29 and 11 MB).
  assert.match(gpsWriteHint("Error reading image data - /x/DSC02106.ARW"), /^Damaged original/);
  assert.equal(gpsWriteHint("Temporary file already exists: /x/C0466.MP4_exiftool_tmp"), "");
});
