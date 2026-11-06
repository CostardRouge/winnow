// lib/favourites.ts + the `favourite` filter against a real database: a pair
// is favourited as one media, clearing takes the whole group, a trashed
// companion is not marked by its surviving primary, the folded grid shows a
// favourited pair once, and nothing about the cull moves. Database-backed:
// runs only with WINNOW_TEST_DATABASE_URL (a migrated scratch database).
// Invented fixtures.
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { skipWithoutDb, useTestDatabase } from "../test/db";

useTestDatabase();

let fav: typeof import("./favourites");
let f: typeof import("./filter");
let db: typeof import("./db");
let sessionId: number;
let rootId: number;
let seq = 0;

before(async () => {
  if (skipWithoutDb) return;
  fav = await import("./favourites");
  f = await import("./filter");
  db = await import("./db");
  const root = await db.one<{ id: number }>(
    "INSERT INTO roots (path, kind, watch) VALUES ('/favourites-test', 'source', false) RETURNING id",
  );
  rootId = root!.id;
  const s = await db.one<{ id: number }>(
    "INSERT INTO sessions (root_id, name, source_path) VALUES ($1, 'fav', '/favourites-test/fav') RETURNING id",
    [rootId],
  );
  sessionId = s!.id;
});

beforeEach(async () => {
  if (skipWithoutDb) return;
  await db.q("DELETE FROM assets WHERE session_id = $1", [sessionId]);
  await db.q("DELETE FROM asset_groups WHERE session_id = $1", [sessionId]);
});

after(async () => {
  if (skipWithoutDb) return;
  await db.q("DELETE FROM assets WHERE session_id = $1", [sessionId]);
  await db.q("DELETE FROM roots WHERE id = $1", [rootId]);
  await db.pool.end();
});

async function file(ext: string, o: { group?: number; role?: string } = {}) {
  seq++;
  const row = await db.one<{ id: number }>(
    `INSERT INTO assets (session_id, abs_path, rel_path, filename, ext, media_type,
                         captured_at, group_id, group_role)
     VALUES ($1, $2, $3, $3, $4, 'photo', now() - ($5 || ' seconds')::interval, $6, $7)
     RETURNING id`,
    [sessionId, `/favourites-test/fav/F${seq}${ext}`, `F${seq}${ext}`, ext, seq, o.group ?? null, o.role ?? null],
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

async function marked(): Promise<number[]> {
  const rows = await db.many<{ asset_id: number }>(
    `SELECT fv.asset_id FROM favourites fv JOIN assets a ON a.id = fv.asset_id
      WHERE a.session_id = $1 ORDER BY fv.asset_id`,
    [sessionId],
  );
  return rows.map((r) => Number(r.asset_id));
}

async function listed(filter: Record<string, unknown>, collapseGroups: boolean): Promise<number[]> {
  const { conditions, params } = f.buildFilter(
    { session_id: sessionId, ...filter } as never,
    1,
    { collapseGroups },
  );
  const rows = await db.many<{ id: number }>(
    `SELECT a.id FROM assets a LEFT JOIN ratings r ON r.asset_id = a.id
      WHERE ${conditions.join(" AND ")} ORDER BY a.id`,
    params,
  );
  return rows.map((r) => Number(r.id));
}

const who = { userId: null, via: "session" as const };

test("a favourite set on one side of a pair marks the whole pair", { skip: skipWithoutDb }, async () => {
  const { hif, arw } = await pair();
  const lone = await file(".jpg");
  await fav.setFavourites({ ids: [arw], on: true, ...who });
  assert.deepEqual(await marked(), [hif, arw].sort((x, y) => x - y));
  // Folded, the pair is ONE favourite tile; unfolded both files match.
  assert.deepEqual(await listed({ favourite: true }, true), [hif]);
  assert.deepEqual(await listed({ favourite: true }, false), [hif, arw]);
  assert.deepEqual(await listed({ favourite: false }, true), [lone]);
});

test("clearing takes the whole group, and a second set changes nothing", { skip: skipWithoutDb }, async () => {
  const { hif } = await pair();
  const first = await fav.setFavourites({ ids: [hif], on: true, ...who });
  assert.equal(first.changed, 2);
  const again = await fav.setFavourites({ ids: [hif], on: true, ...who });
  assert.equal(again.changed, 0, "an existing mark by the same hand is not rewritten");
  const cleared = await fav.setFavourites({ ids: [hif], on: false, ...who });
  assert.equal(cleared.changed, 2);
  assert.deepEqual(await marked(), []);
});

test("a trashed companion is not marked by its surviving primary", { skip: skipWithoutDb }, async () => {
  const { hif, arw } = await pair();
  await db.q("UPDATE assets SET deleted_at = now() WHERE id = $1", [arw]);
  await fav.setFavourites({ ids: [hif], on: true, ...who });
  assert.deepEqual(await marked(), [hif]);
});

test("a favourite moves nothing about the cull", { skip: skipWithoutDb }, async () => {
  const id = await file(".jpg");
  await fav.setFavourites({ ids: [id], on: true, ...who });
  const r = await db.one("SELECT 1 FROM ratings WHERE asset_id = $1", [id]);
  assert.equal(r, null, "no rating row is created");
  const a = await db.one<{ processing_state: string }>(
    "SELECT processing_state FROM assets WHERE id = $1",
    [id],
  );
  assert.equal(a!.processing_state, "unprocessed", "the media is not triaged by a favourite");
});
