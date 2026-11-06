// lib/sessionMoments.ts against a real database: a pair is one frame (its
// companion folded away, its ♥ read through the primary), every frame of a
// burst pile is listed and the pile is one moment, a trashed frame is gone.
// Database-backed: runs only with WINNOW_TEST_DATABASE_URL. Invented fixtures.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { skipWithoutDb, useTestDatabase } from "../test/db";

useTestDatabase();

let sm: typeof import("./sessionMoments");
let fav: typeof import("./favourites");
let db: typeof import("./db");
let sessionId: number;
let rootId: number;
let seq = 0;

before(async () => {
  if (skipWithoutDb) return;
  sm = await import("./sessionMoments");
  fav = await import("./favourites");
  db = await import("./db");
  rootId = (await db.one<{ id: number }>(
    "INSERT INTO roots (path, kind, watch) VALUES ('/moments-test', 'source', false) RETURNING id",
  ))!.id;
  sessionId = (await db.one<{ id: number }>(
    "INSERT INTO sessions (root_id, name, source_path) VALUES ($1, 'mo', '/moments-test/mo') RETURNING id",
    [rootId],
  ))!.id;
});

after(async () => {
  if (skipWithoutDb) return;
  await db.q("UPDATE bursts SET cover_asset_id = NULL WHERE session_id = $1", [sessionId]);
  await db.q("DELETE FROM assets WHERE session_id = $1", [sessionId]);
  await db.q("DELETE FROM roots WHERE id = $1", [rootId]);
  await db.pool.end();
});

async function file(ext: string, min: number, o: { group?: number; role?: string; burst?: number; phash?: string } = {}) {
  seq++;
  return (await db.one<{ id: number }>(
    `INSERT INTO assets (session_id, abs_path, rel_path, filename, ext, media_type, captured_at,
                         group_id, group_role, burst_id, phash)
     VALUES ($1, $2, $3, $3, $4, 'photo', '2026-03-14T06:00:00Z'::timestamptz + ($5 || ' minutes')::interval,
             $6, $7, $8, $9)
     RETURNING id`,
    [sessionId, `/moments-test/mo/M${seq}${ext}`, `M${seq}${ext}`, ext, min,
     o.group ?? null, o.role ?? null, o.burst ?? null, o.phash ?? null],
  ))!.id;
}

test("a folder reads as moments: pairs folded, pile frames listed, trash left out", { skip: skipWithoutDb }, async () => {
  const g = (await db.one<{ id: number }>(
    "INSERT INTO asset_groups (session_id, kind) VALUES ($1, 'raw_jpeg') RETURNING id",
    [sessionId],
  ))!.id;
  const hif = await file(".hif", 0, { group: g, role: "primary", phash: "0" });
  const arw = await file(".arw", 0, { group: g, role: "companion", phash: "0" });
  const b = (await db.one<{ id: number }>(
    "INSERT INTO bursts (session_id) VALUES ($1) RETURNING id",
    [sessionId],
  ))!.id;
  const p1 = await file(".hif", 40, { burst: b, phash: "0" });
  const p2 = await file(".hif", 40.1, { burst: b, phash: "-1" });
  const gone = await file(".hif", 50, { phash: "0" });
  await db.q("UPDATE assets SET deleted_at = now() WHERE id = $1", [gone]);
  await fav.setFavourites({ ids: [arw], on: true, userId: null, via: "session" });

  const r = (await sm.loadSessionMoments(sessionId))!;
  assert.deepEqual(r.frames.map((f) => f.id), [hif, p1, p2]);
  assert.equal(r.frames[0].favourite, true, "the pair's ♥ reads on its primary");
  assert.deepEqual(r.moments.map((m) => m.ids), [[hif], [p1, p2]]);
  assert.deepEqual(r.moments[0].favourite_ids, [hif]);
});

test("an unknown folder is null, not an empty pass", { skip: skipWithoutDb }, async () => {
  assert.equal(await sm.loadSessionMoments(987654321), null);
});
