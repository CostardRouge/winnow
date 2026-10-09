// lib/geoPlaces.ts against a real database: the gallery map's markers group
// located media per ~1 m spot, so a library with far more media than the cap
// still shows every place — the regression was a 10 000 newest-first cap on
// single media that hid everything older and made each bulk placement push
// more off the map. Database-backed: runs only with WINNOW_TEST_DATABASE_URL
// (a migrated scratch database). Invented fixtures.
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { skipWithoutDb, useTestDatabase } from "../test/db";

useTestDatabase();

let gp: typeof import("./geoPlaces");
let db: typeof import("./db");
let sessionId: number;
let rootId: number;
let seq = 0;

before(async () => {
  if (skipWithoutDb) return;
  gp = await import("./geoPlaces");
  db = await import("./db");
  const root = await db.one<{ id: number }>(
    "INSERT INTO roots (path, kind, watch) VALUES ('/geo-places-test', 'source', false) RETURNING id",
  );
  rootId = root!.id;
  const s = await db.one<{ id: number }>(
    "INSERT INTO sessions (root_id, name, source_path) VALUES ($1, 'gp', '/geo-places-test/gp') RETURNING id",
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
  await db.q("DELETE FROM assets WHERE session_id = $1", [sessionId]);
  await db.q("DELETE FROM roots WHERE id = $1", [rootId]);
  await db.pool.end();
});

async function seed(o: {
  day: string;
  gps: { lat: number; lon: number } | null;
  video?: boolean;
}): Promise<number> {
  seq++;
  const ext = o.video ? "mp4" : "arw";
  const row = await db.one<{ id: number }>(
    `INSERT INTO assets (session_id, abs_path, rel_path, filename, ext, media_type,
                         captured_at, gps)
     VALUES ($1, $2, $3, $3, $4, $5, $6::timestamptz, $7::jsonb)
     RETURNING id`,
    [
      sessionId,
      `/geo-places-test/gp/F${seq}.${ext}`,
      `F${seq}.${ext}`,
      ext,
      o.video ? "video" : "photo",
      `${o.day}T10:00:00Z`,
      o.gps ? JSON.stringify(o.gps) : null,
    ],
  );
  return row!.id;
}

// Rainbow Beach (a folder placed in bulk, last year) and Fraser Island (this
// year, a clip shot last).
const OLD = { lat: -25.90411, lon: 153.09102 };
const NEW = { lat: -25.25, lon: 153.15 };

const mine = () => ({ session_ids: [sessionId] });

test("every spot is on the map even when the media outnumber the cap", { skip: skipWithoutDb }, async () => {
  await seed({ day: "2025-03-01", gps: OLD });
  await seed({ day: "2025-03-01", gps: OLD });
  await seed({ day: "2025-03-02", gps: OLD });
  await seed({ day: "2026-07-21", gps: NEW });
  const clip = await seed({ day: "2026-07-22", gps: NEW, video: true });
  await seed({ day: "2026-07-23", gps: null }); // unplaced: no marker

  // Five located media, a cap of two: a per-media cap keeps the two newest
  // (both at NEW) and Rainbow Beach vanishes. Per spot, both stay.
  const r = await gp.geoPlaces(mine(), 2);
  assert.equal(r.truncated, false);
  assert.equal(r.media, 5);
  assert.equal(r.places.length, 2);
  const [fraser, rainbow] = r.places; // newest spot first
  assert.deepEqual(fraser, { id: clip, lat: NEW.lat, lon: NEW.lon, n: 2, video: true });
  assert.equal(rainbow.n, 3);
  assert.equal(rainbow.lat, OLD.lat);
  assert.equal(rainbow.lon, OLD.lon);
  assert.equal(rainbow.video, undefined);
});

test("coordinates a metre apart share a spot; a lone media carries no n", { skip: skipWithoutDb }, async () => {
  await seed({ day: "2026-01-01", gps: { lat: -25.808871, lon: 153.047381 } });
  await seed({ day: "2026-01-02", gps: { lat: -25.808874, lon: 153.047379 } });
  const lone = await seed({ day: "2026-01-03", gps: { lat: 48.85341, lon: 2.3488 } });
  const r = await gp.geoPlaces(mine());
  assert.equal(r.places.length, 2);
  assert.deepEqual(r.places[0], { id: lone, lat: 48.85341, lon: 2.3488 });
  assert.deepEqual(
    { lat: r.places[1].lat, lon: r.places[1].lon, n: r.places[1].n },
    { lat: -25.80887, lon: 153.04738, n: 2 },
  );
});

test("past the cap, the newest spots are kept and the answer says so", { skip: skipWithoutDb }, async () => {
  await seed({ day: "2025-03-01", gps: OLD });
  const recent = await seed({ day: "2026-07-21", gps: NEW });
  const r = await gp.geoPlaces(mine(), 1);
  assert.equal(r.truncated, true);
  assert.deepEqual(r.places, [{ id: recent, lat: NEW.lat, lon: NEW.lon }]);
  assert.equal(r.media, 1);
});

test("the gallery's filters still apply", { skip: skipWithoutDb }, async () => {
  await seed({ day: "2025-03-01", gps: OLD });
  await seed({ day: "2026-07-21", gps: NEW });
  const r = await gp.geoPlaces({ ...mine(), date_from: "2026-01-01" });
  assert.equal(r.places.length, 1);
  assert.equal(r.places[0].lat, NEW.lat);
});
