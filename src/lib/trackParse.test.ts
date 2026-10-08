// Reading an imported track and asking it where a frame was (lib/trackParse.ts).
// Pure: no database. Every fixture is invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  offsetAt,
  parseTrackFiles,
  positionAt,
  toEpochMs,
  TrackParseError,
  type TrackPoint,
} from "./trackParse";

const T0 = Date.UTC(2025, 6, 7, 21, 0, 0); // 2025-07-08 07:00 in Brisbane

test("epoch seconds, milliseconds and ISO strings all read as ms", () => {
  assert.equal(toEpochMs(1751922000), 1751922000000);
  assert.equal(toEpochMs(1751922000000), 1751922000000);
  assert.equal(toEpochMs("2025-07-07T21:00:00Z"), T0);
  assert.equal(toEpochMs("yesterday"), null);
  assert.equal(toEpochMs(-5), null);
});

test("a Polarsteps export: locations + trip combine, steps carry the zones", () => {
  const t = parseTrackFiles([
    {
      name: "locations.json",
      text: JSON.stringify({
        locations: [
          { lat: -25.9, lon: 153.09, time: T0 / 1000 + 600 },
          { lat: -25.8, lon: 153.05, time: T0 / 1000 },
          { lat: 0, lon: 0, time: T0 / 1000 + 50 }, // null island: dropped
          { lat: -25.8, lon: 153.05, time: T0 / 1000 }, // duplicate instant
        ],
      }),
    },
    {
      name: "trip.json",
      text: JSON.stringify({
        name: "Australia",
        all_steps: [
          { start_time: T0 / 1000 + 86400, timezone_id: "Australia/Darwin", display_name: "Alice", location: { lat: -23.7, lon: 133.88 } },
          { start_time: T0 / 1000 - 3600, timezone_id: "Australia/Brisbane", display_name: "Rainbow Beach", location: { lat: -25.9, lon: 153.09 } },
          { start_time: T0 / 1000, is_deleted: true, display_name: "gone" },
        ],
      }),
    },
  ]);
  assert.equal(t.kind, "polarsteps");
  assert.equal(t.name, "Australia");
  assert.equal(t.points.length, 2);
  assert.ok(t.points[0].t < t.points[1].t);
  assert.deepEqual(t.steps.map((s) => s.name), ["Rainbow Beach", "Alice"]);
});

test("a trip file alone is placed by its steps' own positions", () => {
  const t = parseTrackFiles([
    {
      name: "trip.json",
      text: JSON.stringify({ all_steps: [{ start_time: T0 / 1000, timezone_id: "Australia/Brisbane", location: { lat: -25.9, lon: 153.09 } }] }),
    },
  ]);
  assert.equal(t.points.length, 1);
});

test("GPX track points are read with their times", () => {
  const gpx = `<?xml version="1.0"?><gpx version="1.1"><trk><name>Day 1</name><trkseg>
    <trkpt lat="-25.9" lon="153.09"><ele>3</ele><time>2025-07-07T21:00:00Z</time></trkpt>
    <trkpt lon="153.05" lat="-25.8"><time>2025-07-07T21:10:00Z</time></trkpt>
    <trkpt lat="-25.7" lon="153.0"></trkpt>
  </trkseg></trk></gpx>`;
  const t = parseTrackFiles([{ name: "day1.gpx", text: gpx }]);
  assert.equal(t.kind, "gpx");
  assert.equal(t.name, "Day 1");
  assert.deepEqual(t.points.map((p) => p.t), [T0, T0 + 600000]);
});

test("garbage and mixed sources are refused with a reason", () => {
  assert.throws(() => parseTrackFiles([{ name: "x.json", text: "{nope" }]), TrackParseError);
  assert.throws(() => parseTrackFiles([{ name: "x.json", text: '{"foo":1}' }]), /not a Polarsteps/);
  assert.throws(() => parseTrackFiles([{ name: "x.xml", text: "<kml></kml>" }]), /not GPX/);
  assert.throws(
    () =>
      parseTrackFiles([
        { name: "a.gpx", text: '<gpx><trkpt lat="1" lon="1"><time>2025-01-01T00:00:00Z</time></trkpt></gpx>' },
        { name: "locations.json", text: JSON.stringify({ locations: [{ lat: 1, lon: 1, time: 1735689600 }] }) },
      ]),
    /different sources/,
  );
  assert.throws(() => parseTrackFiles([]), /no timed position/);
});

const ROAD: TrackPoint[] = [
  { t: T0, lat: -25.9, lon: 153.0 },
  { t: T0 + 20 * 60000, lat: -25.8, lon: 153.0 }, // ~11 km in 20 min: a road
  { t: T0 + 5 * 3600000, lat: -25.7, lon: 153.0 }, // then a five-hour gap
  { t: T0 + 5.5 * 3600000, lat: -33.9, lon: 151.2 }, // ~930 km in 30 min: a flight
];

test("between two close fixes the position is interpolated", () => {
  const fix = positionAt(ROAD, T0 + 10 * 60000)!;
  assert.equal(fix.method, "interpolated");
  assert.ok(Math.abs(fix.lat - -25.85) < 1e-9);
  assert.equal(fix.gapMin, 10);
});

test("across a gap only a near fix counts, and a gap is no position", () => {
  const near = positionAt(ROAD, T0 + 30 * 60000)!;
  assert.equal(near.method, "nearest");
  assert.equal(near.gapMin, 10);
  assert.equal(positionAt(ROAD, T0 + 2.5 * 3600000), null);
});

test("a flight is never interpolated", () => {
  // Mid-flight: no straight line between the two airports, only the nearest
  // fix (15 min away, the tolerance's edge).
  const mid = positionAt(ROAD, T0 + 5.25 * 3600000)!;
  assert.equal(mid.method, "nearest");
  const t = positionAt(ROAD, T0 + 5.05 * 3600000)!;
  assert.equal(t.method, "nearest");
  assert.equal(t.lat, -25.7);
});

test("the offset follows the steps' zone timeline, else the nearest fix", () => {
  const track = parseTrackFiles([
    {
      name: "trip.json",
      text: JSON.stringify({
        all_steps: [
          { start_time: T0 / 1000, timezone_id: "Australia/Brisbane", location: { lat: -25.9, lon: 153.09 } },
          { start_time: T0 / 1000 + 10 * 86400, timezone_id: "Australia/Darwin", location: { lat: -23.7, lon: 133.88 } },
        ],
      }),
    },
  ]);
  assert.equal(offsetAt(track, T0 + 3600000), 600);
  assert.equal(offsetAt(track, T0 + 11 * 86400000), 570);
  const gpx = parseTrackFiles([
    { name: "p.gpx", text: '<gpx><trkpt lat="-31.95" lon="115.86"><time>2026-01-26T12:00:00Z</time></trkpt></gpx>' },
  ]);
  assert.equal(offsetAt(gpx, Date.UTC(2026, 0, 26, 14)), 480);
  assert.equal(offsetAt(gpx, Date.UTC(2026, 0, 28)), null);
});

test("hours between two fixes at the same spot: the traveller stayed put", () => {
  const camp: TrackPoint[] = [
    { t: T0, lat: -25.9, lon: 153.0 },
    { t: T0 + 6 * 3600000, lat: -25.905, lon: 153.005 }, // ~0.7 km, six hours later
    { t: T0 + 8 * 3600000, lat: -25.6, lon: 153.0 }, // then a drive
  ];
  const stay = positionAt(camp, T0 + 3 * 3600000)!;
  assert.equal(stay.method, "still");
  assert.ok(Math.abs(stay.lat - -25.9025) < 1e-9);
  // Six hours and 33 km apart is not a stay: nothing between them.
  const moved = [camp[0], { ...camp[2], t: T0 + 6 * 3600000 }];
  assert.equal(positionAt(moved, T0 + 3 * 3600000), null);
});
