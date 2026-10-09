// lib/geocode.ts's precise mode reuses the answer of a media already resolved
// at the exact same coordinate: a bulk placement writes ONE point on every
// media of a folder, and each used to cost its own zoom-18 provider call (800
// identical requests for an 800-frame folder). Database-backed: runs only with
// WINNOW_TEST_DATABASE_URL. The provider is stubbed to count calls; a path that
// does call it also takes the Redis rate limiter, which tests do not run.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { skipWithoutDb, useTestDatabase } from "../test/db";

useTestDatabase({ GEOCODE_ENABLED: "true" });

let db: typeof import("./db");
let geocode: typeof import("./geocode");
let settings: typeof import("./settings");
let sessionId: number;
let rootId: number;
let placeId: number;
let calls = 0;
const realFetch = globalThis.fetch;
const AT = { lat: -25.80887, lon: 153.04738 };

before(async () => {
  if (skipWithoutDb) return;
  db = await import("./db");
  geocode = await import("./geocode");
  settings = await import("./settings");
  const root = await db.one<{ id: number }>(
    "INSERT INTO roots (path, kind, watch) VALUES ('/geocode-twin-test', 'source', false) RETURNING id",
  );
  rootId = root!.id;
  const s = await db.one<{ id: number }>(
    "INSERT INTO sessions (root_id, name, source_path) VALUES ($1, 'gt', '/geocode-twin-test/gt') RETURNING id",
    [rootId],
  );
  sessionId = s!.id;
  const { geocodePrecisionM } = await settings.getSettings();
  const cell = geocode.snapToCell(AT.lat, AT.lon, geocodePrecisionM);
  const p = await db.one<{ id: number }>(
    `INSERT INTO places (cell_lat, cell_lon, precision_m, country, city, display_name, provider)
     VALUES ($1, $2, $3, 'Australia', 'Tin Can Bay', 'Great Sandy Strait', 'test')
     ON CONFLICT (cell_lat, cell_lon, precision_m) DO UPDATE SET city = 'Tin Can Bay'
     RETURNING id`,
    [cell.cellLat, cell.cellLon, geocodePrecisionM],
  );
  placeId = Number(p!.id);
  globalThis.fetch = (async () => {
    calls++;
    throw new Error("network call");
  }) as typeof fetch;
});

afterEach(() => {
  calls = 0;
});

after(async () => {
  globalThis.fetch = realFetch;
  if (skipWithoutDb) return;
  await db.q("DELETE FROM assets WHERE session_id = $1", [sessionId]);
  await db.q("DELETE FROM roots WHERE id = $1", [rootId]);
  await db.q("DELETE FROM places WHERE id = $1", [placeId]);
  await db.pool.end();
});

let seq = 0;
async function placed(o: { done?: boolean } = {}) {
  seq++;
  const row = await db.one<{ id: number }>(
    `INSERT INTO assets (session_id, abs_path, rel_path, filename, ext, media_type,
                         captured_at, gps, geocode_status, place_id, place_poi)
     VALUES ($1, $2, $3, $3, '.hif', 'photo', now(), $4::jsonb, $5, $6, $7)
     RETURNING id`,
    [sessionId, `/geocode-twin-test/gt/F${seq}.hif`, `F${seq}.hif`,
     JSON.stringify(AT),
     o.done ? "ready" : "pending", o.done ? placeId : null, o.done ? "Snapper Creek" : null],
  );
  return Number(row!.id);
}

test("a media placed where another was already resolved copies its answer", { skip: skipWithoutDb }, async () => {
  await placed({ done: true });
  const id = await placed();
  await geocode.runGeocodeJob(id, { precise: true });
  assert.equal(calls, 0);
  const r = await db.one<{ s: string; city: string; poi: string }>(
    "SELECT geocode_status AS s, place_city AS city, place_poi AS poi FROM assets WHERE id = $1",
    [id],
  );
  assert.deepEqual(r, { s: "ready", city: "Tin Can Bay", poi: "Snapper Creek" });
});
