// The pure rules of lib/clockSuggestions.ts: which gap two bodies' look-alike
// photos agree on, which body moves, and which shift reconciles a body's own
// positions with a GPS track. The database half is in captureCorrections.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestFromTrack, suggestFromTwins } from "./clockSuggestions";

const H = 3600_000;
const twin = (i: number, gapMs: number, x = "SONY", y = "PHONE") => ({
  xId: i,
  xDev: x,
  xWall: Date.UTC(2026, 10, 11, 20) + i * 60_000,
  yId: 100 + i,
  yDev: y,
  yWall: Date.UTC(2026, 10, 11, 20) + i * 60_000 + gapMs,
});

test("most twins agreeing on one non-zero gap make one suggestion", () => {
  const twins = [twin(1, 9 * H), twin(2, 9 * H + 4 * 60_000), twin(3, 9 * H - 3 * 60_000), twin(4, 2 * H)];
  const out = suggestFromTwins(twins, new Map([["SONY", 0], ["PHONE", 1]]));
  assert.equal(out.length, 1);
  assert.deepEqual([out[0].device, out[0].reference, out[0].shiftS], ["SONY", "PHONE", 9 * 3600]);
  assert.deepEqual([out[0].pairs, out[0].agreeing], [4, 3]);
});

test("the body whose files know where they are stays put, whichever side was sampled", () => {
  // Sampled from the phone's side: the gap is −9 h, the Sony still moves +9 h.
  const twins = [1, 2, 3].map((i) => twin(i, -9 * H, "PHONE", "SONY"));
  const out = suggestFromTwins(twins, new Map([["SONY", 0], ["PHONE", 0.9]]));
  assert.deepEqual([out[0].device, out[0].shiftS], ["SONY", 9 * 3600]);
});

test("no suggestion for clocks that agree, too few twins, or no majority", () => {
  const share = new Map([["SONY", 0], ["PHONE", 1]]);
  assert.equal(suggestFromTwins([1, 2, 3, 4].map((i) => twin(i, 2 * 60_000)), share).length, 0);
  assert.equal(suggestFromTwins([twin(1, 9 * H), twin(2, 9 * H)], share).length, 0);
  const split = [twin(1, 9 * H), twin(2, 9 * H), twin(3, 9 * H), twin(4, 3 * H), twin(5, 5 * H), twin(6, 7 * H)];
  assert.equal(suggestFromTwins(split, share).length, 0);
});

test("the shift that puts a body's own positions back on the track", () => {
  // A track along a meridian, 1° (111 km) of latitude per hour.
  const t0 = Date.UTC(2026, 0, 3, 8);
  const fixAt = (t: number) =>
    t >= t0 - 24 * H && t <= t0 + 24 * H ? { lat: (t - t0) / H, lon: 0 } : null;
  // The frames were taken at t0+k h (latitude k) but their clock says 1 h less.
  const frames = [0, 1, 2, 3, 4].map((k) => ({ instantMs: t0 + (k - 1) * H, lat: k, lon: 0 }));
  const s = suggestFromTrack(frames, fixAt);
  assert.deepEqual(s, { shiftS: 3600, frames: 5, conflicts: 5, resolved: 5 });
  // Frames that already agree with the track raise nothing.
  const fine = [0, 1, 2].map((k) => ({ instantMs: t0 + k * H, lat: k, lon: 0 }));
  assert.equal(suggestFromTrack(fine, fixAt), null);
});
