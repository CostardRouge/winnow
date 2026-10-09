// lib/filter.ts's fold (`collapseGroups`) against a real database: a RAW+JPEG
// pair and a burst pile each show as ONE tile, and that tile is a member that
// matches the filter — never a fixed member the filter then hides. Measured
// before the fix on the maintainer's library: `.arw` showed 1 171 of 44 553
// RAWs, Picks / Rejects lacked 191 / 190 frames inside piles. Database-backed:
// runs only with WINNOW_TEST_DATABASE_URL (a migrated scratch database).
// Invented fixtures.
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { skipWithoutDb, useTestDatabase } from "../test/db";
import type { PartialAssetFilter } from "./filter";

useTestDatabase();

let f: typeof import("./filter");
let db: typeof import("./db");
let sessionId: number;
let rootId: number;
let seq = 0;

before(async () => {
  if (skipWithoutDb) return;
  f = await import("./filter");
  db = await import("./db");
  const root = await db.one<{ id: number }>(
    "INSERT INTO roots (path, kind, watch) VALUES ('/filter-fold-test', 'source', false) RETURNING id",
  );
  rootId = root!.id;
  const s = await db.one<{ id: number }>(
    "INSERT INTO sessions (root_id, name, source_path) VALUES ($1, 'ff', '/filter-fold-test/ff') RETURNING id",
    [rootId],
  );
  sessionId = s!.id;
});

beforeEach(async () => {
  if (skipWithoutDb) return;
  await db.q("UPDATE bursts SET cover_asset_id = NULL WHERE session_id = $1", [sessionId]);
  await db.q("DELETE FROM assets WHERE session_id = $1", [sessionId]);
  await db.q("DELETE FROM bursts WHERE session_id = $1", [sessionId]);
  await db.q("DELETE FROM asset_groups WHERE session_id = $1", [sessionId]);
});

after(async () => {
  if (skipWithoutDb) return;
  await db.q("UPDATE bursts SET cover_asset_id = NULL WHERE session_id = $1", [sessionId]);
  await db.q("DELETE FROM assets WHERE session_id = $1", [sessionId]);
  await db.q("DELETE FROM roots WHERE id = $1", [rootId]);
  await db.pool.end();
});

async function file(ext: string, o: { group?: number; role?: string; burst?: number; seq?: number } = {}) {
  seq++;
  const row = await db.one<{ id: number }>(
    `INSERT INTO assets (session_id, abs_path, rel_path, filename, ext, media_type,
                         captured_at, group_id, group_role, burst_id, burst_seq)
     VALUES ($1, $2, $3, $3, $4, 'photo', now() - ($5 || ' seconds')::interval, $6, $7, $8, $9)
     RETURNING id`,
    [sessionId, `/filter-fold-test/ff/F${seq}${ext}`, `F${seq}${ext}`, ext, seq,
     o.group ?? null, o.role ?? null, o.burst ?? null, o.seq ?? null],
  );
  return row!.id;
}

async function pair() {
  const g = await db.one<{ id: number }>(
    "INSERT INTO asset_groups (session_id, kind) VALUES ($1, 'raw_jpeg') RETURNING id",
    [sessionId],
  );
  const hif = await file(".hif", { group: g!.id, role: "primary" });
  const arw = await file(".arw", { group: g!.id, role: "companion" });
  return { hif, arw };
}

async function pile(n: number) {
  const b = await db.one<{ id: number }>(
    "INSERT INTO bursts (session_id) VALUES ($1) RETURNING id",
    [sessionId],
  );
  const frames: number[] = [];
  for (let k = 0; k < n; k++) frames.push(await file(".hif", { burst: b!.id, seq: k }));
  await db.q("UPDATE bursts SET cover_asset_id = $1 WHERE id = $2", [frames[0], b!.id]);
  return frames;
}

const rate = (id: number, verdict: string) =>
  db.q(
    `INSERT INTO ratings (asset_id, verdict, star) VALUES ($1, $2, 0)
     ON CONFLICT (asset_id) DO UPDATE SET verdict = $2`,
    [id, verdict],
  );

async function folded(filter: PartialAssetFilter = {}): Promise<number[]> {
  const { conditions, params } = f.buildFilter(
    { ...filter, session_id: sessionId },
    1,
    { collapseGroups: true },
  );
  const rows = await db.many<{ id: number }>(
    `SELECT a.id FROM assets a LEFT JOIN ratings r ON r.asset_id = a.id
      WHERE ${conditions.join(" AND ")} ORDER BY a.id`,
    params as never[],
  );
  return rows.map((r) => Number(r.id));
}

test("unfiltered, a pair is its primary and a pile is its cover", { skip: skipWithoutDb }, async () => {
  const { hif } = await pair();
  const frames = await pile(3);
  const lone = await file(".jpg");
  assert.deepEqual(await folded(), [hif, frames[0], lone].sort((x, y) => x - y));
});

test("an extension filter shows the paired RAW it asks for", { skip: skipWithoutDb }, async () => {
  const { hif, arw } = await pair();
  // Before the fold was filter-aware: [] — the RAW is the companion, its HIF
  // fails `.arw`, so the pair vanished.
  assert.deepEqual(await folded({ ext: [".arw"] }), [arw]);
  assert.deepEqual(await folded({ ext: [".hif"] }), [hif]);
});

test("a RAW whose HIF was trashed is still in the grid", { skip: skipWithoutDb }, async () => {
  const { hif, arw } = await pair();
  await db.q("UPDATE assets SET deleted_at = now() WHERE id = $1", [hif]);
  assert.deepEqual(await folded(), [arw]);
});

test("a pick inside a pile shows under Picks, a picked cover still wins", { skip: skipWithoutDb }, async () => {
  const frames = await pile(4);
  await rate(frames[2], "pick");
  // Before: [] — the cover is unrated, so the pile vanished from Picks.
  assert.deepEqual(await folded({ verdict: "pick" }), [frames[2]]);
  await rate(frames[3], "pick");
  assert.deepEqual(await folded({ verdict: "pick" }), [frames[2]]);
  await rate(frames[0], "pick");
  assert.deepEqual(await folded({ verdict: "pick" }), [frames[0]]);
});

test("Sift's unrated view keeps offering a pile until every frame is rated", { skip: skipWithoutDb }, async () => {
  const frames = await pile(3);
  await rate(frames[0], "reject");
  assert.deepEqual(await folded({ verdict: "unrated" }), [frames[1]]);
  await rate(frames[1], "pick");
  await rate(frames[2], "pick");
  assert.deepEqual(await folded({ verdict: "unrated" }), []);
});

test("a rated pair stays out of Unrated: both members carry the rating", { skip: skipWithoutDb }, async () => {
  const { hif, arw } = await pair();
  await rate(hif, "pick");
  await rate(arw, "pick");
  assert.deepEqual(await folded({ verdict: "unrated" }), []);
  assert.deepEqual(await folded({ verdict: "pick" }), [hif]);
});

test("drilling into one pile returns every frame", { skip: skipWithoutDb }, async () => {
  const frames = await pile(3);
  const burst = await db.one<{ burst_id: number }>("SELECT burst_id FROM assets WHERE id = $1", [frames[0]]);
  assert.deepEqual(await folded({ burst_id: Number(burst!.burst_id) }), frames);
});
