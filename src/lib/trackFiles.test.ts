import { test } from "node:test";
import assert from "node:assert/strict";
import { identifyTrackFile } from "./trackFiles";

test("a Polarsteps locations file is the positions, with its span", () => {
  const text = JSON.stringify({
    locations: [
      { lat: -26.4, lon: 153.1, time: 1751923818 },
      { lat: -26.5, lon: 153.0, time: 1751930000 },
      { nothing: true },
    ],
  });
  const r = identifyTrackFile("locations.json", text);
  assert.ok(r.ok);
  assert.equal(r.slot, "positions");
  assert.equal(r.count, 2);
  assert.equal(r.from, 1751923818000);
  assert.equal(r.to, 1751930000000);
});

test("a Polarsteps trip file is the steps, with the trip's name", () => {
  const text = JSON.stringify({
    name: "Invented trip",
    all_steps: [{ start_time: 1751923818 }, { start_time: 1752000000 }, { name: "undated" }],
  });
  const r = identifyTrackFile("trip.json", text);
  assert.ok(r.ok);
  assert.equal(r.slot, "steps");
  assert.equal(r.count, 2);
  assert.equal(r.title, "Invented trip");
});

test("a GPX file is recognised whatever it is called", () => {
  const gpx = `<?xml version="1.0"?><gpx><trk><name>Demo road</name><trkseg>
    <trkpt lat="1" lon="2"><time>2025-07-08T00:00:00Z</time></trkpt>
    <trkpt lat="1.1" lon="2.1"><time>2025-07-08T01:00:00Z</time></trkpt></trkseg></trk></gpx>`;
  const r = identifyTrackFile("export (3).txt", gpx);
  assert.ok(r.ok);
  assert.equal(r.slot, "gpx");
  assert.equal(r.count, 2);
  assert.equal(r.title, "Demo road");
  assert.equal(r.to! - r.from!, 3_600_000);
});

test("anything else is refused with a reason", () => {
  for (const [name, text] of [
    ["empty.json", "  "],
    ["photo.json", '{"width": 10}'],
    ["notes.txt", "hello"],
    ["page.xml", "<html></html>"],
  ]) {
    const r = identifyTrackFile(name, text);
    assert.equal(r.ok, false, name);
    assert.ok(!r.ok && r.error.length > 0);
  }
});
