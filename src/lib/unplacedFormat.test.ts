// How the Unplaced view words a gap and a distance (lib/unplacedFormat.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { distText, gapText, spanText } from "./unplacedFormat";

test("spanText reads like the card's sentence", () => {
  assert.equal(spanText(47_000), "47 s");
  assert.equal(spanText(87_000), "1 min 27 s");
  assert.equal(spanText(120_000), "2 min");
  assert.equal(spanText(12 * 60_000 + 5_000), "12 min");
  assert.equal(spanText(65 * 60_000), "1 h 05");
  assert.equal(spanText(-5), "0 s");
});

test("distText rounds metres to ten and switches to km", () => {
  assert.equal(distText(0), "0 m");
  assert.equal(distText(44), "40 m");
  assert.equal(distText(1449), "1.4 km");
});

test("gapText names the side and switches to days past a day", () => {
  assert.equal(gapText(0), "same hours");
  assert.equal(gapText(-0.2), "1 h before");
  assert.equal(gapText(5.4), "5 h after");
  assert.equal(gapText(-30), "1 day before");
  assert.equal(gapText(72), "3 days after");
});
