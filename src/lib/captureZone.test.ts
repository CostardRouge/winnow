// The local-day arithmetic (migration 0046, lib/captureZone.ts). Pure: no
// database. The trigger is checked against the same cases in
// captureDays.test.ts when a test database is available.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyCaptureTime,
  decideOwnZone,
  localDay,
  outranks,
  placeOffsetMinutes,
  trueInstant,
  zoneAt,
  zoneOffsetMinutes,
} from "./captureZone";

// Rainbow Beach, Queensland (no DST, +10) — the case that started this.
const QLD = { lat: -25.9, lon: 153.09 };
// Melbourne (+10 in winter, +11 under DST), Perth (+8), Alice Springs (+9:30).
const MEL = { lat: -37.81, lon: 144.96 };
const PER = { lat: -31.95, lon: 115.86 };
const ASP = { lat: -23.7, lon: 133.88 };

test("a 07:30 Queensland frame is filed on its LOCAL day, not the UTC one", () => {
  // 2025-07-08 07:30 +10:00 is 2025-07-07 21:30 UTC — the old trigger's day.
  const at = new Date("2025-07-08T07:30:18+10:00");
  assert.equal(localDay(at, "exif", null), "2025-07-07");
  assert.equal(localDay(at, "exif", 600), "2025-07-08");
});

test("a wall clock is its own local day, whatever offset is learnt", () => {
  // Stored as if UTC since 0001: 07:30 'Z' is the wall clock 07:30.
  const wall = new Date("2025-07-08T07:30:18Z");
  assert.equal(localDay(wall, "exif-wall", null), "2025-07-08");
  assert.equal(localDay(wall, "exif-wall", 600), "2025-07-08");
  assert.equal(trueInstant(wall, "exif-wall", 600).toISOString(), "2025-07-07T21:30:18.000Z");
  assert.equal(trueInstant(wall, "exif", 600).toISOString(), wall.toISOString());
});

test("zones and offsets are read offline, DST included", () => {
  assert.equal(zoneAt(QLD.lat, QLD.lon), "Australia/Brisbane");
  assert.equal(zoneAt(PER.lat, PER.lon), "Australia/Perth");
  const july = new Date("2025-07-15T00:00:00Z");
  const december = new Date("2025-12-15T00:00:00Z");
  assert.equal(placeOffsetMinutes(MEL.lat, MEL.lon, july), 600);
  assert.equal(placeOffsetMinutes(MEL.lat, MEL.lon, december), 660);
  assert.equal(placeOffsetMinutes(PER.lat, PER.lon, december), 480);
  assert.equal(placeOffsetMinutes(ASP.lat, ASP.lon, december), 570);
  assert.equal(zoneOffsetMinutes("Europe/Paris", july), 120);
  assert.equal(zoneOffsetMinutes("Europe/Paris", december), 60);
});

test("garbage positions and zones answer null, never throw", () => {
  assert.equal(zoneAt(NaN, 10), null);
  assert.equal(zoneAt(95, 10), null);
  assert.equal(zoneOffsetMinutes("Not/AZone", new Date()), null);
  assert.equal(zoneOffsetMinutes("Europe/Paris", new Date(NaN)), null);
});

test("the place outranks the camera, the camera outranks nothing", () => {
  assert.equal(outranks("gps", "exif"), true);
  assert.equal(outranks("neighbour", "exif"), true);
  assert.equal(outranks("track", "neighbour"), true);
  assert.equal(outranks("exif", "neighbour"), false);
  assert.equal(outranks("neighbour", "track"), false);
  assert.equal(outranks("exif", null), true);
});

test("a camera-written zone is kept as weak evidence; an inferred one is not", () => {
  assert.deepEqual(
    classifyCaptureTime({ hasZone: true, tzoffsetMinutes: 600, inferredZone: false }, "OffsetTimeOriginal"),
    { source: "exif", exifOffsetMin: 600 },
  );
  // exiftool zoned it from the file's GPS: an instant, offset left to the position pass.
  assert.deepEqual(
    classifyCaptureTime({ hasZone: true, tzoffsetMinutes: 600, inferredZone: true }, "GPSLatitude/GPSLongitude"),
    { source: "exif", exifOffsetMin: null },
  );
  // A QuickTime date is UTC by convention, which says nothing about the place.
  assert.deepEqual(
    classifyCaptureTime({ hasZone: true, tzoffsetMinutes: 0, inferredZone: true }, "defaultVideosToUTC"),
    { source: "exif", exifOffsetMin: null },
  );
  assert.deepEqual(classifyCaptureTime({ hasZone: false }, undefined), {
    source: "exif-wall",
    exifOffsetMin: null,
  });
  assert.deepEqual(classifyCaptureTime(null, null), { source: "file", exifOffsetMin: null });
});

test("own position beats the camera: a Sony left on Brisbane time in Paris", () => {
  const at = new Date("2026-02-27T21:38:23Z"); // 22:38 in Paris, 07:38 in Brisbane
  const d = decideOwnZone({
    capturedAt: at,
    capturedAtSource: "exif",
    lat: 48.79,
    lon: 2.45,
    offsetMin: 600,
    offsetSource: "exif",
  });
  assert.deepEqual(d, { offsetMin: 60, offsetSource: "gps" });
  assert.equal(localDay(at, "exif", d.offsetMin), "2026-02-27");
});

test("with no position the camera's word stands, a stronger source is kept", () => {
  const at = new Date("2025-07-08T03:08:18Z");
  assert.deepEqual(
    decideOwnZone({ capturedAt: at, capturedAtSource: "exif", lat: null, lon: null, offsetMin: null, offsetSource: null, exifOffsetMin: 600 }),
    { offsetMin: 600, offsetSource: "exif" },
  );
  assert.deepEqual(
    decideOwnZone({ capturedAt: at, capturedAtSource: "exif", lat: null, lon: null, offsetMin: 570, offsetSource: "track", exifOffsetMin: 600 }),
    { offsetMin: 570, offsetSource: "track" },
  );
});

test("an unclassified row is placed only by a position read from the file", () => {
  const f = {
    capturedAt: new Date("2025-07-07T21:30:00Z"),
    capturedAtSource: null,
    lat: QLD.lat,
    lon: QLD.lon,
    offsetMin: null,
    offsetSource: null,
  };
  assert.deepEqual(decideOwnZone(f), { offsetMin: null, offsetSource: null });
  assert.deepEqual(decideOwnZone(f, { positionFromFile: true }), { offsetMin: 600, offsetSource: "gps" });
});

test("a wall clock across a DST edge takes the offset of its true instant", () => {
  // Melbourne leaves DST on 2026-04-05 at 03:00 local (+11 → +10). A wall
  // clock of 04:30 that morning is already +10.
  const wall = new Date("2026-04-05T04:30:00Z");
  const d = decideOwnZone({
    capturedAt: wall,
    capturedAtSource: "exif-wall",
    lat: MEL.lat,
    lon: MEL.lon,
    offsetMin: null,
    offsetSource: null,
  });
  assert.deepEqual(d, { offsetMin: 600, offsetSource: "gps" });
});
