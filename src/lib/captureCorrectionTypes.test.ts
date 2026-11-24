// The pure rules of a clock correction (lib/captureCorrectionTypes.ts), shared
// by the server and the dialog: the local wall clock, the typed time, the
// stacking of shifts, and what a person reads.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyMoved,
  formatShift,
  instantMs,
  localWallMs,
  nextShift,
  parseLocalInput,
  wallIso,
} from "./captureCorrectionTypes";

test("a frame's local wall clock follows the 0046 day rule", () => {
  const at = Date.UTC(2026, 10, 11, 19, 41);
  // A zoned instant is shifted by the place's offset…
  assert.equal(wallIso(localWallMs(at, "exif", 600)), "2026-11-12T05:41:00");
  // …a wall clock already IS the local time…
  assert.equal(wallIso(localWallMs(at, "exif-wall", 600)), "2026-11-11T19:41:00");
  // …and with no zone known the day is UTC's.
  assert.equal(wallIso(localWallMs(at, "exif", null)), "2026-11-11T19:41:00");
});

test("a typed local time is read strictly", () => {
  assert.equal(parseLocalInput("2026-11-12T07:41"), Date.UTC(2026, 10, 12, 7, 41));
  assert.equal(parseLocalInput("2026-11-12 07:41:09"), Date.UTC(2026, 10, 12, 7, 41, 9));
  assert.equal(parseLocalInput("2026-02-31T07:41"), null, "no rolling over into March");
  assert.equal(parseLocalInput("12/11/2026 07:41"), null);
});

test("shifts stack, a zero sum is no correction, a revert clears", () => {
  assert.equal(nextShift(null, 3600), 3600);
  assert.equal(nextShift(32400, 3600), 36000);
  assert.equal(nextShift(3600, -3600), null);
  assert.equal(nextShift(32400, null), null);
});

test("a shift reads as a person would say it", () => {
  assert.equal(formatShift(32400), "+9 h");
  assert.equal(formatShift(-5400), "−1 h 30 min");
  assert.equal(formatShift(86400 + 7200), "+1 day 2 h");
  assert.equal(formatShift(37), "+37 s");
  assert.equal(formatShift(null), "none");
});

test("pg's timestamptz text is read where Safari's Date.parse is not", () => {
  assert.equal(instantMs("2026-11-12 05:41:00+00"), Date.UTC(2026, 10, 12, 5, 41));
  assert.equal(instantMs("2026-11-12 05:41:00.5+05:30"), Date.UTC(2026, 10, 12, 0, 11, 0, 500));
  assert.equal(instantMs("2026-11-12T05:41:00.000Z"), Date.UTC(2026, 10, 12, 5, 41));
  assert.equal(instantMs("not a date"), null);
  assert.equal(instantMs(null), null);
});

test("moved rows patch a list in place and leave the rest", () => {
  const items = [
    { id: 1, captured_at: "a", filename: "x" },
    { id: 2, captured_at: "b", filename: "y" },
  ];
  const out = applyMoved(items, [
    {
      id: 2,
      captured_at: "c",
      captured_at_file: "b",
      capture_shift_s: 60,
      capture_offset_min: null,
      capture_offset_source: null,
    },
  ]);
  assert.equal(out[0], items[0]);
  assert.equal(out[1].captured_at, "c");
  assert.equal(out[1].filename, "y");
});
