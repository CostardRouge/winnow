// The Unplaced view's pure rules (lib/unplacedTypes.ts): the place split that
// stops one folder's two towns from being placed at one point, and the sort
// the page offers. Invented coordinates: Montpellier and Sète, ~30 km apart.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  betterConfidence,
  bracketEvidence,
  type EvidenceFix,
  impossibleLeg,
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
    conflict: null,
    nearest: null,
    moments: null,
    neighbours: null,
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

const PORTO = { lat: 41.1496, lon: -8.611 };
const MELBOURNE = { lat: -37.8136, lon: 144.9631 };

test("impossibleLeg: Porto then Melbourne two hours later is no journey", () => {
  const runs = placeRuns(
    [donor(10, PORTO), donor(10.5, PORTO), donor(12.5, MELBOURNE), donor(13, MELBOURNE)],
    5000,
    2,
  );
  const leg = impossibleLeg(runs, 1000);
  assert.ok(leg, "flagged");
  assert.equal(leg.k, 0);
  assert.ok(leg.km > 17000 && leg.km < 19000, String(leg.km));
});

test("impossibleLeg: a drive, and even a flight, are journeys", () => {
  // Montpellier → Sète in three hours: 10 km/h.
  const drive = placeRuns(
    [donor(9, MPL), donor(10, MPL), donor(13, SETE), donor(14, SETE)],
    5000,
    2,
  );
  assert.equal(impossibleLeg(drive, 1000), null);
  // Porto → Paris (~1 200 km) in three hours: an airliner's 400 km/h.
  const PARIS = { lat: 48.8566, lon: 2.3522 };
  const flight = placeRuns(
    [donor(8, PORTO), donor(9, PORTO), donor(12, PARIS), donor(13, PARIS)],
    5000,
    2,
  );
  assert.equal(impossibleLeg(flight, 1000), null);
});

// --- Confidence by distance (tight_km, docs/UNPLACED.md §12) -----------------

const AMS = { lat: 52.3731, lon: 4.8922 };
const ZAANDAM = { lat: 52.4389, lon: 4.8262 };

function fix(iso: string, at: { lat: number; lon: number }, filename = "DSC.ARW"): EvidenceFix {
  return { at: iso, filename, model: "ILCE-7CM2", name: null, lat: at.lat, lon: at.lon };
}

test("bracketEvidence: a frame on each side at the same spot brackets the card — high, pin on the nearer", () => {
  const t = Date.parse("2025-01-31T14:59:03Z");
  const before = fix("2025-01-31T14:58:16Z", AMS, "DSC02079.HIF");
  const after = fix("2025-01-31T15:26:34Z", { lat: AMS.lat + 0.001, lon: AMS.lon }, "DSC02217.ARW");
  const r = bracketEvidence(t, t, before, after, null, 2000)!;
  assert.equal(r.confidence, "high");
  assert.equal(r.evidence.basis, "bracketed");
  assert.equal(r.pin?.filename, "DSC02079.HIF", "47 s before beats 27 min after");
  assert.ok(r.evidence.spread_m > 100 && r.evidence.spread_m < 200, String(r.evidence.spread_m));
});

test("bracketEvidence: one side only is medium; nothing is null", () => {
  const t = Date.parse("2025-01-31T14:59:03Z");
  const r = bracketEvidence(t, t, fix("2025-01-31T14:40:00Z", AMS), null, null, 2000)!;
  assert.equal(r.confidence, "medium");
  assert.equal(r.evidence.basis, "one_side");
  assert.equal(bracketEvidence(t, t, null, null, null, 2000), null);
});

test("bracketEvidence: sides further apart than tight_km decide nothing", () => {
  const t = Date.parse("2025-01-31T14:59:03Z");
  // Zaandam is ~8 km from Amsterdam: the card moved, or one side is wrong.
  assert.equal(bracketEvidence(t, t, fix("2025-01-31T14:58:00Z", ZAANDAM), fix("2025-01-31T15:00:00Z", AMS), null, 2000), null);
});

test("bracketEvidence: the frames inside the card count too — far ones veto, near ones alone are medium", () => {
  const t0 = Date.parse("2025-01-31T14:00:00Z");
  const t1 = Date.parse("2025-01-31T16:00:00Z");
  const before = fix("2025-01-31T13:58:00Z", AMS);
  const after = fix("2025-01-31T16:01:00Z", AMS);
  const far = { n: 3, lat_min: AMS.lat, lat_max: ZAANDAM.lat, lon_min: ZAANDAM.lon, lon_max: AMS.lon };
  assert.equal(bracketEvidence(t0, t1, before, after, far, 2000), null);
  const near = { n: 2, lat_min: AMS.lat, lat_max: AMS.lat + 0.002, lon_min: AMS.lon, lon_max: AMS.lon + 0.002 };
  const only = bracketEvidence(t0, t1, null, null, near, 2000)!;
  assert.equal(only.confidence, "medium");
  assert.equal(only.evidence.basis, "inside");
  assert.equal(only.pin, null, "no side to pin on: the share's median stands");
});

test("betterConfidence never lowers", () => {
  assert.equal(betterConfidence("low", "high"), "high");
  assert.equal(betterConfidence("high", "medium"), "high");
  assert.equal(betterConfidence("medium", "low"), "medium");
});
