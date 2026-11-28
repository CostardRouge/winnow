// The viewer's actions act on the burst frame on screen, never on the pile's
// cover the host's list holds (viewerSubject.ts). Before 2026-11-28 a verdict
// given to frame 4 of a pile landed on frame 1: "it applies to the whole
// burst". Pure, no database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { viewerSubject } from "./viewerSubject";

const cover = { id: 1, verdict: "unrated", star: 0, filename: "DSC0001.ARW", distance: 0.2 };
const frame4 = { id: 4, verdict: "unrated", star: 0, filename: "DSC0004.ARW" };

test("with frame actions on, the frame on screen is what a verdict rates", () => {
  const s = viewerSubject(cover, frame4, true);
  assert.equal(s.id, 4);
  assert.equal(s.filename, "DSC0004.ARW");
});

test("the frame's own cull state is read, not the cover's", () => {
  const s = viewerSubject({ ...cover, verdict: "pick" }, { ...frame4, verdict: "reject" }, true);
  assert.equal(s.verdict, "reject");
});

test("a field the pile read does not carry keeps the item's value", () => {
  assert.equal(viewerSubject(cover, frame4, true).distance, 0.2);
});

test("with no frame picked, or frame actions off, the host's item is the subject", () => {
  assert.equal(viewerSubject(cover, null, true), cover);
  assert.equal(viewerSubject(cover, frame4, false), cover);
});
