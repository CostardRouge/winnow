// lib/instant.ts: pg's text form of a timestamptz, made ISO for a client.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isoInstant } from "./instant";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

test("isoInstant turns pg's text form into ISO 8601", () => {
  assert.equal(isoInstant("2025-03-10 09:00:00+00"), "2025-03-10T09:00:00.000Z");
  assert.equal(isoInstant("2025-03-10 11:00:00+02"), "2025-03-10T09:00:00.000Z");
  assert.match(isoInstant("2025-03-10 09:00:00.5+00"), ISO);
});

test("isoInstant floors a start and ceils an end past the millisecond", () => {
  const t = "2025-03-10 09:00:00.123456+00";
  assert.equal(isoInstant(t), "2025-03-10T09:00:00.123Z");
  assert.equal(isoInstant(t, "ceil"), "2025-03-10T09:00:00.124Z");
  // Nothing past the millisecond: nothing to round up.
  assert.equal(isoInstant("2025-03-10 09:00:00.123000+00", "ceil"), "2025-03-10T09:00:00.123Z");
  assert.equal(isoInstant("2025-03-10 09:00:00+00", "ceil"), "2025-03-10T09:00:00.000Z");
});

test("isoInstant refuses text that is not an instant", () => {
  assert.throws(() => isoInstant("not a date"), RangeError);
});
