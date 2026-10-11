// The Unplaced view's pure rules (lib/unplacedTypes.ts): the place split that
// stops one folder's two towns from being placed at one point, and the sort
// the page offers. Invented coordinates: Montpellier and Sète, ~30 km apart.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  placeCuts,
  placeRuns,
  traceStops,
  type TraceFrame,
  runSuggestion,
  sortGroups,
  parseUnplacedSort,
  type UnplacedDonor,
  type UnplacedGroup,
} from "./unplacedTypes";

const H = 3_600_000;
const MPL = { lat: 43.6108, lon: 3.8767 };
const SETE = { lat: 43.4028, lon: 3.6928 };

function donor(h: number, at: { lat: number; lon: number }, cell: number | null = null): UnplacedDonor {
  return { at: h * H, lat: at.lat, lon: at.lon, cell, name: null, model: "iPhone" };
}

test("placeRuns: one place stays one run", () => {
  const runs = placeRuns([donor(10, MPL), donor(11, MPL), donor(12, MPL)], 5000, 2);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].donors.length, 3);
});

test("placeRuns: a move past split_km starts a new place", () => {
  const runs = placeRuns(
    [donor(10, MPL), donor(11, MPL), donor(15, SETE), donor(16, SETE)],
    5000,
    2,
  );
  assert.equal(runs.length, 2);
  assert.equal(runs[0].last, 11 * H);
  assert.equal(runs[1].first, 15 * H);
});

test("placeRuns: a single stray fix neither splits nor stands as a place", () => {
  // A A [Sète once] A A — the stray is dropped and the two halves re-join.
  const runs = placeRuns(
    [donor(10, MPL), donor(11, MPL), donor(11.5, SETE), donor(12, MPL), donor(13, MPL)],
    5000,
    2,
  );
  assert.equal(runs.length, 1);
  assert.equal(runs[0].donors.length, 4);
  assert.equal(runs[0].first, 10 * H);
  assert.equal(runs[0].last, 13 * H);
});

test("placeCuts: cuts in the camera's longest silence between two places", () => {
  // Phone in Montpellier until 10:00, in Sète from 15:00. The camera shot
  // Montpellier every ten minutes until 14:00, then Sète from 14:40: the
  // midpoint (12:30) would put an hour and a half of Montpellier in Sète; the
  // forty-minute drive is the longest silence.
  const runs = placeRuns(
    [donor(9, MPL), donor(10, MPL), donor(15, SETE), donor(16, SETE)],
    5000,
    2,
  );
  const media: number[] = [];
  for (let m = 10 * 60 + 10; m <= 14 * 60; m += 10) media.push((m / 60) * H);
  for (let m = 14 * 60 + 40; m <= 15 * 60; m += 10) media.push((m / 60) * H);
  const [cut] = placeCuts(runs, media);
  assert.ok(cut > 14 * H && cut < (14 + 40 / 60) * H, `cut at ${cut / H} h`);
});

test("placeCuts: no media between two places → the midpoint", () => {
  const runs = placeRuns(
    [donor(9, MPL), donor(10, MPL), donor(14, SETE), donor(15, SETE)],
    5000,
    2,
  );
  assert.deepEqual(placeCuts(runs, [8 * H, 16 * H]), [12 * H]);
});

test("runSuggestion: the dominant cell's median, share and confidence", () => {
  const ds = [
    donor(1, MPL, 1),
    donor(2, { lat: MPL.lat + 0.002, lon: MPL.lon }, 1),
    donor(3, { lat: MPL.lat + 0.004, lon: MPL.lon }, 1),
    donor(4, MPL, 1),
    donor(5, MPL, 1),
    donor(6, SETE, 2),
  ];
  const s = runSuggestion(ds);
  assert.equal(s.located, 6);
  assert.equal(s.share, 5 / 6);
  assert.equal(s.confidence, "medium");
  assert.equal(s.lat, MPL.lat + 0.0); // median of [0, 0, 0, .002, .004] offsets
  assert.equal(s.donor_model, "iPhone");
});

function card(id: number, folderUnplaced: number, unplaced: number, t0: string, extra: Partial<UnplacedGroup> = {}): UnplacedGroup {
  return {
    key: `${id}:${t0}`,
    kind: "shoot",
    sessions: [
      {
        id,
        name: `f${id}`,
        device_hint: null,
        captured_at_min: t0,
        captured_at_max: t0,
        total: folderUnplaced,
        unplaced: folderUnplaced,
        exempt: 0,
        no_exif: 0,
        sample: [],
      },
    ],
    siblings: [],
    t0,
    t1: t0,
    total: unplaced,
    unplaced,
    exempt: 0,
    no_exif: 0,
    sample: [],
    suggestion: null,
    part: null,
    stops: null,
    nearest: null,
    moments: null,
    ...extra,
  };
}

test("sortGroups size: biggest FOLDER first, its parts together and in time order", () => {
  const a1 = card(1, 900, 400, "2026-04-02T10:00:00Z");
  const a2 = card(1, 900, 500, "2026-04-01T10:00:00Z");
  const b = card(2, 600, 600, "2026-03-01T10:00:00Z");
  const c = card(3, 50, 50, "2026-05-01T10:00:00Z");
  assert.deepEqual(
    sortGroups([c, a1, b, a2], "size").map((g) => g.key),
    [a2.key, a1.key, b.key, c.key],
  );
});

test("sortGroups by date, and the URL value falls back to size", () => {
  const a = card(1, 1, 1, "2026-01-01T00:00:00Z");
  const b = card(2, 1, 1, "2026-02-01T00:00:00Z");
  assert.deepEqual(sortGroups([a, b], "newest").map((g) => g.sessions[0].id), [2, 1]);
  assert.deepEqual(sortGroups([b, a], "oldest").map((g) => g.sessions[0].id), [1, 2]);
  assert.equal(parseUnplacedSort(null), "size");
  assert.equal(parseUnplacedSort("bogus"), "size");
  assert.equal(parseUnplacedSort("ready"), "ready");
});

function tf(id: number, min: number, at: { lat: number; lon: number } | null): TraceFrame {
  return { id, at: min * 60000, pos: at, source: at ? "inferred" : null, import_id: null };
}

test("traceStops: frames in two towns are two stops, frames with no point are gaps", () => {
  const frames = [
    tf(1, 0, MPL), tf(2, 5, MPL), tf(3, 10, MPL),
    tf(4, 20, null),
    tf(5, 200, SETE), tf(6, 205, SETE), tf(7, 210, SETE),
  ];
  const { runs, gaps } = traceStops(frames, 5000);
  assert.deepEqual(runs.map((r) => r.frames.map((f) => f.id)), [[1, 2, 3], [5, 6, 7]]);
  assert.deepEqual(gaps, [4]);
  assert.ok(runs.every((r) => !r.moving));
});

test("traceStops: frames shot along a road join one moving stop, not a list of tiny ones", () => {
  // An hour in Montpellier, then one frame every ~6 km on the way to Sète,
  // six minutes apart, then an hour in Sète.
  // (The last road frame stays ~10 km short of Sète: one within split_km of
  // it would rightly join the Sète stop.)
  const road = Array.from({ length: 3 }, (_, k) => ({
    lat: MPL.lat - (k + 1) * 0.045,
    lon: MPL.lon - (k + 1) * 0.035,
  }));
  const frames = [
    tf(1, 0, MPL), tf(2, 30, MPL), tf(3, 60, MPL),
    ...road.map((p, k) => tf(10 + k, 70 + k * 6, p)),
    tf(20, 100, SETE), tf(21, 130, SETE), tf(22, 160, SETE),
  ];
  const { runs } = traceStops(frames, 5000);
  assert.equal(runs.length, 3, JSON.stringify(runs.map((r) => r.frames.map((f) => f.id))));
  assert.equal(runs[1].moving, true);
  assert.deepEqual(runs[1].frames.map((f) => f.id), [10, 11, 12]);
  assert.equal(runs[0].moving, false);
  assert.equal(runs[2].moving, false);
});
