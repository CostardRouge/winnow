// The position writes against a real database: a geotag clears the old place
// names with the old point, a folded grid's geotag / exempt reaches the RAW of
// each pair, a queued EXIF write never puts a non-manual position into an
// original, and a bulk placement at one coordinate costs one geocoder call.
// Database-backed: runs only with WINNOW_TEST_DATABASE_URL (a migrated scratch
// database). Invented fixtures; the geocoder's network is stubbed to fail, so
// any call it makes fails the test that did not expect one.
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { skipWithoutDb, useTestDatabase } from "../test/db";

// Geocoding on for runGeocodeJob; the geotag route then enqueues on Redis, so
// its tests go through `inferred` + a stubbed enqueue (see `post`).
useTestDatabase({ GEOCODE_ENABLED: "false" });

let db: typeof import("./db");
let geotag: typeof import("../app/api/assets/geotag/route");
let exempt: typeof import("../app/api/assets/geo-exempt/route");
let exifWrite: typeof import("./exifWrite");
let sessionId: number;
let rootId: number;
let seq = 0;

before(async () => {
  if (skipWithoutDb) return;
  db = await import("./db");
  geotag = await import("../app/api/assets/geotag/route");
  exempt = await import("../app/api/assets/geo-exempt/route");
  exifWrite = await import("./exifWrite");
  const root = await db.one<{ id: number }>(
    "INSERT INTO roots (path, kind, watch) VALUES ('/geo-writes-test', 'source', false) RETURNING id",
  );
  rootId = root!.id;
  const s = await db.one<{ id: number }>(
    "INSERT INTO sessions (root_id, name, source_path) VALUES ($1, 'gw', '/geo-writes-test/gw') RETURNING id",
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

async function file(ext: string, o: { group?: number; role?: string; gps?: { lat: number; lon: number } } = {}) {
  seq++;
  const row = await db.one<{ id: number }>(
    `INSERT INTO assets (session_id, abs_path, rel_path, filename, ext, media_type,
                         captured_at, group_id, group_role, gps)
     VALUES ($1, $2, $3, $3, $4, 'photo', now(), $5, $6, $7::jsonb)
     RETURNING id`,
    [sessionId, `/geo-writes-test/gw/F${seq}${ext}`, `F${seq}${ext}`, ext,
     o.group ?? null, o.role ?? null, o.gps ? JSON.stringify(o.gps) : null],
  );
  return Number(row!.id);
}

async function pair(rawGps?: { lat: number; lon: number }) {
  const g = await db.one<{ id: number }>(
    "INSERT INTO asset_groups (session_id, kind) VALUES ($1, 'raw_jpeg') RETURNING id",
    [sessionId],
  );
  const hif = await file(".hif", { group: g!.id, role: "primary" });
  const arw = await file(".arw", { group: g!.id, role: "companion", gps: rawGps });
  return { hif, arw };
}

const post = (handler: (r: NextRequest) => Promise<Response>, body: unknown) =>
  handler(
    new NextRequest("http://test.local/api", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
  ).then(async (r) => ({ status: r.status, body: await r.json() }));

const row = (id: number) =>
  db.one<{ lat: number | null; src: string | null; city: string | null; country: string | null; exempt: boolean }>(
    `SELECT gps_lat AS lat, gps_source AS src, place_city AS city,
            place_country AS country, geo_exempt_at IS NOT NULL AS exempt
       FROM assets WHERE id = $1`,
    [id],
  );

test("a geotag clears the names of the place it moved away from", { skip: skipWithoutDb }, async () => {
  const id = await file(".hif", { gps: { lat: -31.95, lon: 115.86 } });
  await db.q("UPDATE assets SET place_city = 'Perth', place_country = 'Australia' WHERE id = $1", [id]);
  const r = await post(geotag.POST, { ids: [id], lat: -33.87, lon: 151.21, source: "inferred" });
  assert.equal(r.status, 200);
  // Before: still 'Perth' until the geocoder caught up — or forever with it off.
  assert.deepEqual(await row(id), { lat: -33.87, src: "inferred", city: null, country: null, exempt: false });
});

test("from a folded grid, the RAW of a pair is placed with its HIF", { skip: skipWithoutDb }, async () => {
  const { hif, arw } = await pair();
  const r = await post(geotag.POST, { ids: [hif], lat: 48.85, lon: 2.35, source: "inferred", companions: true });
  assert.equal(r.body.updated, 2);
  assert.equal((await row(arw))!.lat, 48.85);
});

test("the RAW's own position is never overwritten unseen", { skip: skipWithoutDb }, async () => {
  const { hif, arw } = await pair({ lat: 43.6, lon: 3.9 });
  await post(geotag.POST, { ids: [hif], lat: 48.85, lon: 2.35, source: "inferred", companions: true });
  assert.equal((await row(arw))!.lat, 43.6);
});

test("without the flag, only the listed ids are written (the Unplaced recap lists every file)", { skip: skipWithoutDb }, async () => {
  const { hif, arw } = await pair();
  const r = await post(geotag.POST, { ids: [hif], lat: 48.85, lon: 2.35, source: "inferred" });
  assert.equal(r.body.updated, 1);
  assert.equal((await row(arw))!.lat, null);
});

test("exempting from a folded grid takes the pair, un-exempting gives it back", { skip: skipWithoutDb }, async () => {
  const { hif, arw } = await pair();
  await post(exempt.POST, { ids: [hif], exempt: true, companions: true });
  assert.equal((await row(arw))!.exempt, true);
  await post(exempt.POST, { ids: [hif], exempt: false, companions: true });
  assert.equal((await row(arw))!.exempt, false);
});

test("a queued EXIF write skips a position that is no longer a manual pin", { skip: skipWithoutDb }, async () => {
  // The file does not exist: had the job tried to write, it would have failed
  // with 'error'. A guess must end 'skipped', never written.
  const id = await file(".arw", { gps: { lat: 48.85, lon: 2.35 } });
  await db.q("UPDATE assets SET gps_source = 'inferred', gps_write_status = 'pending' WHERE id = $1", [id]);
  await exifWrite.runGpsWriteJob(id);
  const st = await db.one<{ s: string }>("SELECT gps_write_status AS s FROM assets WHERE id = $1", [id]);
  assert.equal(st!.s, "skipped");
});
