// Migration 0046 + lib/captureDays.ts against a real database: the trigger
// files a frame on its LOCAL day, the passes give each frame the right offset,
// and a preview writes nothing. Database-backed: runs only with
// WINNOW_TEST_DATABASE_URL (a migrated scratch database).
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { skipWithoutDb, useTestDatabase } from "../test/db";

useTestDatabase();

let cd: typeof import("./captureDays");
let db: typeof import("./db");
let sessionId: number;
let rootId: number;
let seq = 0;

before(async () => {
  if (skipWithoutDb) return;
  cd = await import("./captureDays");
  db = await import("./db");
  const root = await db.one<{ id: number }>(
    "INSERT INTO roots (path, kind, watch) VALUES ('/capture-days-test', 'source', false) RETURNING id",
  );
  rootId = root!.id;
  const s = await db.one<{ id: number }>(
    "INSERT INTO sessions (root_id, name, source_path) VALUES ($1, 'cd', '/capture-days-test/cd') RETURNING id",
    [rootId],
  );
  sessionId = s!.id;
});

beforeEach(async () => {
  if (skipWithoutDb) return;
  await db.q("DELETE FROM assets WHERE session_id = $1", [sessionId]);
});

after(async () => {
  if (skipWithoutDb) return;
  await db.q("DELETE FROM roots WHERE id = $1", [rootId]);
  await db.pool.end();
});

type Seed = {
  at: string;
  source?: "exif" | "exif-wall" | "file" | null;
  gps?: { lat: number; lon: number } | null;
  gpsSource?: "manual" | "inferred" | null;
  offset?: number | null;
  offsetSource?: string | null;
  mtime?: string;
};

async function seed(s: Seed): Promise<number> {
  seq++;
  const row = await db.one<{ id: number }>(
    `INSERT INTO assets (session_id, abs_path, rel_path, filename, ext, media_type,
                         captured_at, captured_at_source, gps, gps_source,
                         capture_offset_min, capture_offset_source, file_mtime)
     VALUES ($1, $2, $3, $3, 'jpg', 'photo', $4, $5, $6::jsonb, $7, $8, $9, $10)
     RETURNING id`,
    [
      sessionId,
      `/capture-days-test/cd/f${seq}.jpg`,
      `f${seq}.jpg`,
      s.at,
      s.source === undefined ? "exif" : s.source,
      s.gps ? JSON.stringify(s.gps) : null,
      s.gpsSource ?? null,
      s.offset ?? null,
      s.offsetSource ?? null,
      s.mtime ?? "2026-03-04T19:16:16Z",
    ],
  );
  return row!.id;
}

const day = async (id: number) =>
  (await db.one<{ d: string; o: number | null; s: string | null }>(
    `SELECT to_char(capture_date, 'YYYY-MM-DD') AS d,
            capture_offset_min AS o, capture_offset_source AS s
       FROM assets WHERE id = $1`,
    [id],
  ))!;

const QLD = { lat: -25.9, lon: 153.09 };

test("the trigger files a zoned frame on its local day once an offset is known", { skip: skipWithoutDb }, async () => {
  const id = await seed({ at: "2025-07-08T07:30:18+10:00" });
  assert.equal((await day(id)).d, "2025-07-07"); // the pre-0046 UTC day
  await db.q("UPDATE assets SET capture_offset_min = 600 WHERE id = $1", [id]);
  assert.equal((await day(id)).d, "2025-07-08");
  await db.q("UPDATE assets SET capture_offset_min = NULL WHERE id = $1", [id]);
  assert.equal((await day(id)).d, "2025-07-07"); // clearing restores the old day
});

test("a wall clock keeps its own date whatever offset it learns", { skip: skipWithoutDb }, async () => {
  const id = await seed({ at: "2025-07-08T07:30:18Z", source: "exif-wall", offset: 600, offsetSource: "neighbour" });
  assert.equal((await day(id)).d, "2025-07-08");
});

test("own position: a frame with GPS takes its place's offset", { skip: skipWithoutDb }, async () => {
  const id = await seed({ at: "2025-07-08T07:30:18+10:00", gps: QLD, offset: 60, offsetSource: "exif" });
  assert.equal(await cd.applyOwnZones([id]), 1);
  assert.deepEqual(await day(id), { d: "2025-07-08", o: 600, s: "gps" });
});

test("an unclassified row is placed by a file position, not by a human one", { skip: skipWithoutDb }, async () => {
  const fromFile = await seed({ at: "2025-07-07T21:30:00Z", source: null, gps: QLD });
  const byHand = await seed({ at: "2025-07-07T21:30:00Z", source: null, gps: QLD, gpsSource: "inferred" });
  await cd.applyOwnZones([fromFile, byHand]);
  assert.deepEqual(await day(fromFile), { d: "2025-07-08", o: 600, s: "gps" });
  assert.deepEqual(await day(byHand), { d: "2025-07-07", o: null, s: null });
  const cls = await db.one<{ s: string }>("SELECT captured_at_source AS s FROM assets WHERE id = $1", [fromFile]);
  assert.equal(cls!.s, "exif");
});

test("a frame with no position borrows the nearest place within the window", { skip: skipWithoutDb }, async () => {
  // The iPhone at 06:50 knows Queensland; the Sony at 07:30 says nothing.
  const phone = await seed({ at: "2025-07-08T06:50:00+10:00", gps: QLD });
  const sony = await seed({ at: "2025-07-08T07:30:18+10:00" });
  const far = await seed({ at: "2025-07-10T07:30:18+10:00" });
  await cd.applyOwnZones([phone]);
  const changed = await cd.inheritNeighbourZones({ ids: [sony, far] });
  assert.equal(changed, 1);
  assert.deepEqual(await day(sony), { d: "2025-07-08", o: 600, s: "neighbour" });
  assert.deepEqual(await day(far), { d: "2025-07-09", o: null, s: null });
});

test("a neighbour outranks the camera's own zone, never a position", { skip: skipWithoutDb }, async () => {
  // A Sony still on Brisbane time in Paris, next to a located phone frame.
  const phone = await seed({ at: "2026-02-27T21:30:00Z", gps: { lat: 48.79, lon: 2.45 } });
  const sony = await seed({ at: "2026-02-27T21:38:23Z", offset: 600, offsetSource: "exif" });
  await cd.applyOwnZones([phone]);
  await cd.inheritNeighbourZones({ ids: [sony, phone] });
  assert.deepEqual(await day(sony), { d: "2026-02-27", o: 60, s: "neighbour" });
  assert.deepEqual(await day(phone), { d: "2026-02-27", o: 60, s: "gps" });
});

test("a preview reports the repair and writes nothing", { skip: skipWithoutDb }, async () => {
  const phone = await seed({ at: "2025-07-07T20:50:00Z", source: null, gps: QLD });
  const sony = await seed({ at: "2025-07-07T21:30:18Z", source: "exif" });
  const copy = await seed({ at: "2026-03-04T19:16:16Z", source: null, mtime: "2026-03-04T19:16:16Z" });
  const r = await cd.runCaptureDayBackfill({ apply: false });
  assert.equal(r.apply, false);
  assert.ok(r.fromPosition >= 1);
  assert.ok(r.fromNeighbour >= 1);
  assert.deepEqual(await day(phone), { d: "2025-07-07", o: null, s: null });
  assert.deepEqual(await day(sony), { d: "2025-07-07", o: null, s: null });
  const cls = await db.one<{ s: string | null }>("SELECT captured_at_source AS s FROM assets WHERE id = $1", [copy]);
  assert.equal(cls!.s, null);

  const applied = await cd.runCaptureDayBackfill({ apply: true });
  assert.equal(applied.apply, true);
  assert.deepEqual(await day(phone), { d: "2025-07-08", o: 600, s: "gps" });
  assert.deepEqual(await day(sony), { d: "2025-07-08", o: 600, s: "neighbour" });
  const cls2 = await db.one<{ s: string | null }>("SELECT captured_at_source AS s FROM assets WHERE id = $1", [copy]);
  assert.equal(cls2!.s, "file");
});

test("a 'file' whose time is not its mtime goes back to the re-read; a true one stays", { skip: skipWithoutDb }, async () => {
  // What the first, -fast2 re-read left on every camera clip: 'file' over a
  // time the indexer had read from the file.
  const clip = await seed({ at: "2025-07-07T21:30:18Z", source: "file", mtime: "2026-03-04T19:16:16Z" });
  const copy = await seed({ at: "2026-03-04T19:16:16Z", source: "file", mtime: "2026-03-04T19:16:16Z" });
  const before = await day(clip);
  const r = await cd.runCaptureDayBackfill({ apply: true });
  assert.ok(r.relabelled >= 1);
  const src = async (id: number) =>
    (await db.one<{ s: string | null }>("SELECT captured_at_source AS s FROM assets WHERE id = $1", [id]))!.s;
  assert.equal(await src(clip), null);
  assert.equal(await src(copy), "file");
  assert.deepEqual(await day(clip), before); // no day moves
});

test("the re-read classifies only the frames of its window, from the file's own tags", { skip: skipWithoutDb }, async () => {
  const { default: sharp } = await import("sharp");
  const { exiftool } = await import("exiftool-vendored");
  const dir = await mkdtemp(path.join(os.tmpdir(), "winnow-capture-"));
  try {
    const file = async (name: string, tags: Record<string, string>) => {
      const p = path.join(dir, name);
      await sharp({ create: { width: 8, height: 8, channels: 3, background: "#888" } }).jpeg().toFile(p);
      await exiftool.write(p, tags, { writeArgs: ["-overwrite_original"] });
      return p;
    };
    const zoned = await file("zoned.jpg", { DateTimeOriginal: "2025:07:08 07:30:18", OffsetTimeOriginal: "+10:00" });
    const wall = await file("wall.jpg", { DateTimeOriginal: "2025:07:08 07:40:00" });
    const outside = await file("outside.jpg", { DateTimeOriginal: "2025:09:01 12:00:00", OffsetTimeOriginal: "+09:30" });
    const row = async (p: string, at: string) =>
      (await db.one<{ id: number }>(
        `INSERT INTO assets (session_id, abs_path, rel_path, filename, ext, media_type, captured_at)
         VALUES ($1, $2, $3, $3, 'jpg', 'photo', $4) RETURNING id`,
        [sessionId, p, path.basename(p), at],
      ))!.id;
    const a = await row(zoned, "2025-07-07T21:30:18Z");
    const b = await row(wall, "2025-07-08T07:40:00Z");
    const c = await row(outside, "2025-09-01T02:30:00Z");
    const r = await cd.runCaptureDayBackfill({
      apply: true,
      reread: true,
      from: "2025-07-07T00:00:00Z",
      to: "2025-07-09T00:00:00Z",
    });
    assert.equal(r.reread_files, 2);
    const cls = async (id: number) =>
      (await db.one<{ s: string | null; o: number | null; os: string | null }>(
        `SELECT captured_at_source AS s, capture_offset_min AS o, capture_offset_source AS os
           FROM assets WHERE id = $1`,
        [id],
      ))!;
    // The Sony-style file is zoned, its camera's +10:00 kept as weak evidence
    // (no place nearby to outrank it); the drone-style one is a wall clock.
    assert.deepEqual(await cls(a), { s: "exif", o: 600, os: "exif" });
    assert.deepEqual(await cls(b), { s: "exif-wall", o: null, os: null });
    assert.deepEqual(await cls(c), { s: null, o: null, os: null });
    assert.equal((await day(a)).d, "2025-07-08");
    assert.equal((await day(b)).d, "2025-07-08");
  } finally {
    await (await import("./extract")).closeExiftool();
    await rm(dir, { recursive: true, force: true });
  }
});
