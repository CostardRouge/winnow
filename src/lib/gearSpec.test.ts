// A body's archetype (lib/gearSpec.ts): an unrecognised MODEL string keeps the
// neutral "rangefinder style" guess, but a name typed by hand is not a model —
// it gets the matchers when it states a shape, and "unknown" otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cameraKind, CAMERA_KINDS } from "./gearSpec";

test("a model string the matchers miss keeps the rangefinder-style guess", () => {
  assert.equal(cameraKind("ACME Q9"), "rangefinder");
  assert.equal(cameraKind("SONY ILCE-7CM2"), "rangefinder");
  assert.equal(cameraKind("FUJIFILM X-S20"), "slr");
});

test("a name typed by hand is not guessed at", () => {
  assert.equal(cameraKind("Salsa dancer", true), "unknown");
  assert.equal(cameraKind("Aymeric's Sony camera", true), "unknown");
  assert.equal(CAMERA_KINDS[cameraKind("QQ Tencent", true)], "Unknown type");
});

test("…but keeps the shape its words state", () => {
  assert.equal(cameraKind("Aymeric's iPhone", true), "phone");
  assert.equal(cameraKind("Emeric's GoPro", true), "action");
  assert.equal(cameraKind("the DJI of the wedding", true), "drone");
});
