// lib/moments.ts: how a folder folds into moments for the favourites pass,
// and which moments are suggested. Pure, invented fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupMoments, hamming, suggest, type MomentFrame } from "./moments";

const T0 = Date.parse("2026-03-14T06:00:00Z");
let next = 0;
function frame(min: number, o: Partial<MomentFrame> = {}): MomentFrame {
  next++;
  return {
    id: next,
    captured_at: new Date(T0 + min * 60_000).toISOString(),
    media_type: "photo",
    phash: "0",
    burst_id: null,
    sharpness: null,
    face_count: 0,
    verdict: "unrated",
    star: 0,
    favourite: false,
    ...o,
  };
}

test("hamming counts differing bits over 64, signed BIGINTs included", () => {
  assert.equal(hamming("0", "0"), 0);
  assert.equal(hamming("0", "255"), 8);
  assert.equal(hamming("-1", "0"), 64);
  assert.equal(hamming("-1", "-2"), 1);
});

test("look-alike frames close in time are one moment; a new look or a long gap starts another", () => {
  const a = frame(0, { phash: "0" });
  const b = frame(1, { phash: "3" }); // 2 bits from a
  const c = frame(2, { phash: "65535" }); // 16 bits: a different picture
  const d = frame(30, { phash: "65535" }); // same look as c, 28 min later
  const m = groupMoments([d, c, b, a]);
  assert.deepEqual(m.map((x) => x.ids), [[a.id, b.id], [c.id], [d.id]]);
});

test("a burst pile is one moment whatever its hashes, and a frame without a hash stands alone", () => {
  const p1 = frame(0, { burst_id: 7, phash: "0" });
  const p2 = frame(0.1, { burst_id: 7, phash: "4294967295" });
  const lone = frame(0.2, { phash: null });
  const m = groupMoments([p1, p2, lone]);
  assert.deepEqual(m.map((x) => x.ids), [[p1.id, p2.id], [lone.id]]);
});

test("a chain of look-alikes stops at the span cap", () => {
  const frames = Array.from({ length: 8 }, (_, i) => frame(i * 8, { phash: "0" }));
  const m = groupMoments(frames);
  assert.ok(m.length >= 2, "eight frames over 56 min are not one moment");
  for (const x of m) {
    const first = Date.parse(frames.find((f) => f.id === x.ids[0])!.captured_at!);
    const last = Date.parse(frames.find((f) => f.id === x.ids[x.ids.length - 1])!.captured_at!);
    assert.ok(last - first <= 30 * 60_000);
  }
});

test("a photo and a video never share a moment", () => {
  const p = frame(0);
  const v = frame(0.5, { media_type: "video" });
  assert.equal(groupMoments([p, v]).length, 2);
});

test("the cover is the frame already chosen: favourite, then pick, then stars, then the sharpest", () => {
  const a = frame(0, { sharpness: 90 });
  const b = frame(0.5, { sharpness: 10, verdict: "pick" });
  const c = frame(1, { sharpness: 50, favourite: true });
  assert.equal(groupMoments([a, b, c])[0].cover_id, c.id);
  assert.equal(groupMoments([a, b])[0].cover_id, b.id);
  const d = frame(2, { sharpness: 20 });
  const e = frame(2.5, { sharpness: 80 });
  assert.equal(groupMoments([d, e])[0].cover_id, e.id);
});

test("suggestions skip moments that hold a favourite and rejects, and stop at the target", () => {
  const frames = [
    frame(0, { phash: "0", verdict: "pick" }),
    frame(20, { phash: "0", face_count: 2 }),
    frame(40, { phash: "0", favourite: true, verdict: "pick" }),
    frame(60, { phash: "0", verdict: "reject", star: 5 }),
    frame(80, { phash: "0" }),
  ];
  const s = suggest(groupMoments(frames), frames, 2);
  assert.deepEqual(
    s.map((m) => m.suggested ?? null),
    ["Pick", null, null, null, null],
    "one favourite already fills a place: room for one more, the pick",
  );
  const wide = suggest(groupMoments(frames), frames, 10);
  assert.deepEqual(wide.map((m) => m.suggested ?? null), ["Pick", "Faces", null, null, null]);
});
