// lib/trackImport.ts against a real database: a preview writes nothing, an
// apply places the unplaced frames and zones the ones in a gap, keeps every
// position a file or a human gave, reports a camera fix the track contradicts,
// and Undo takes back exactly what it wrote. Database-backed: runs only with
// WINNOW_TEST_DATABASE_URL (a migrated scratch database). Invented fixtures.
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { skipWithoutDb, useTestDatabase } from "../test/db";
import type { ParsedTrack } from "./trackParse";

// The geocoder stays off so an apply never needs Redis.
useTestDatabase({ GEOCODE_ENABLED: "false" });

let ti: typeof import("./trackImport");
let db: typeof import("./db");
let sessionId: number;
let rootId: number;
let seq = 0;

before(async () => {
  if (skipWithoutDb) return;
  ti = await import("./trackImport");
  db = await import("./db");
  const root = await db.one<{ id: number }>(
    "INSERT INTO roots (path, kind, watch) VALUES ('/track-import-test', 'source', false) RETURNING id",
  );
  rootId = root!.id;
  const s = await db.one<{ id: number }>(
    "INSERT INTO sessions (root_id, name, source_path) VALUES ($1, 'ti', '/track-import-test/ti') RETURNING id",
    [rootId],
  );
  sessionId = s!.id;
});

beforeEach(async () => {
  if (skipWithoutDb) return;
  await db.q("DELETE FROM assets WHERE session_id = $1", [sessionId]);
  await db.q("DELETE FROM track_imports WHERE name LIKE 'test-%'");
});

after(async () => {
  if (skipWithoutDb) return;
  await db.q("DELETE FROM track_imports WHERE name LIKE 'test-%'");
  await db.q("DELETE FROM roots WHERE id = $1", [rootId]);
  await db.pool.end();
});

// Its own dates, apart from captureDays.test.ts's: the two files share one
// database and may run at once, and an import touches every frame of its span.
const T0 = Date.UTC(2024, 2, 10, 20, 0, 0); // 2024-03-11 06:00 in Brisbane
const MIN = 60000;

// A road north of Rainbow Beach, one fix every 10 min for an hour, then a
// four-hour gap that ends 40 km away — a drive the track did not record, so
// the frames in it get a zone and no position.
const TRACK: ParsedTrack = {
  kind: "polarsteps",
  name: "test-road",
  points: [
    ...[0, 10, 20, 30, 40, 50, 60].map((m, i) => ({ t: T0 + m * MIN, lat: -25.9 + i * 0.01, lon: 153.05 })),
    { t: T0 + 300 * MIN, lat: -25.5, lon: 153.05 },
  ],
  steps: [{ t: T0 - 60 * MIN, zone: "Australia/Brisbane", name: "Rainbow Beach", lat: -25.9, lon: 153.09 }],
};

async function seed(o: {
  min: number;
  gps?: { lat: number; lon: number };
  gpsSource?: string | null;
  source?: string | null;
}): Promise<number> {
  seq++;
  const row = await db.one<{ id: number }>(
    `INSERT INTO assets (session_id, abs_path, rel_path, filename, ext, media_type,
                         captured_at, captured_at_source, gps, gps_source)
     VALUES ($1, $2, $3, $3, 'arw', 'photo', to_timestamp($4 / 1000.0), $5, $6::jsonb, $7)
     RETURNING id`,
    [
      sessionId,
      `/track-import-test/ti/DSC${seq}.ARW`,
      `DSC${seq}.ARW`,
      T0 + o.min * MIN,
      o.source === undefined ? "exif" : o.source,
      o.gps ? JSON.stringify(o.gps) : null,
      o.gpsSource ?? null,
    ],
  );
  return row!.id;
}

const state = async (id: number) =>
  (await db.one<{
    lat: number | null;
    src: string | null;
    off: number | null;
    osrc: string | null;
    day: string;
    imp: string | null;
  }>(
    `SELECT gps_lat AS lat, gps_source AS src, capture_offset_min AS off,
            capture_offset_source AS osrc, to_char(capture_date, 'YYYY-MM-DD') AS day,
            track_import_id::text AS imp
       FROM assets WHERE id = $1`,
    [id],
  ))!;

test("preview: the report says what would happen and nothing is written", { skip: skipWithoutDb }, async () => {
  const sony = await seed({ min: 15 });
  const r = await ti.runTrackImport(TRACK);
  assert.equal(r.apply, false);
  assert.equal(r.inSpan, 1);
  assert.equal(r.located.interpolated, 1);
  assert.equal(r.daysChanged, 1); // 06:15 Brisbane was filed on the 10th (UTC)
  assert.deepEqual(await state(sony), { lat: null, src: null, off: null, osrc: null, day: "2024-03-10", imp: null });
  const n = await db.one<{ n: number }>("SELECT count(*)::int AS n FROM track_imports WHERE name = 'test-road'");
  assert.equal(n!.n, 0);
});

test("apply: unplaced frames are placed, a gap is zoned, others are kept", { skip: skipWithoutDb }, async () => {
  const sony = await seed({ min: 15 });
  const gap = await seed({ min: 180 });
  const phone = await seed({ min: 25, gps: { lat: -25.88, lon: 153.05 } });
  const wrongClock = await seed({ min: 35, gps: { lat: -33.87, lon: 151.21 } }); // Sydney
  const byHand = await seed({ min: 45, gps: { lat: -25.5, lon: 153.0 }, gpsSource: "manual" });
  const suggested = await seed({ min: 46, gps: { lat: -25.6, lon: 153.0 }, gpsSource: "inferred" });
  const old = await seed({ min: 20, source: null });

  const r = await ti.runTrackImport(TRACK, { apply: true });
  assert.ok(r.importId);
  assert.equal(r.located.interpolated, 1);
  assert.equal(r.zonedOnly, 1);
  assert.equal(r.ownPosition, 2);
  assert.equal(r.manualKept, 1);
  assert.equal(r.inferredKept, 1);
  assert.equal(r.unclassified, 1);
  assert.equal(r.conflictCount, 1);
  assert.equal(r.conflicts[0].id, wrongClock);

  const s = await state(sony);
  assert.equal(s.src, "track");
  assert.ok(Math.abs(s.lat! - -25.885) < 1e-6);
  assert.equal(s.off, 600);
  assert.equal(s.osrc, "track");
  assert.equal(s.day, "2024-03-11");
  assert.equal(s.imp, String(r.importId));

  const g = await state(gap);
  assert.deepEqual([g.lat, g.src, g.off, g.osrc, g.day], [null, null, 600, "track", "2024-03-11"]);
  assert.equal((await state(phone)).src, null);
  assert.equal((await state(byHand)).src, "manual");
  assert.equal((await state(suggested)).src, "inferred");
  assert.equal((await state(old)).src, null);
});

test("undo takes back exactly what the import wrote", { skip: skipWithoutDb }, async () => {
  const sony = await seed({ min: 15 });
  const gap = await seed({ min: 180 });
  const r = await ti.runTrackImport(TRACK, { apply: true });
  const listed = await ti.listTrackImports();
  const mine = listed.find((t) => t.id === Number(r.importId))!;
  assert.equal(mine.placed, 1);
  assert.equal(mine.zoned, 2);

  const out = await ti.revertTrackImport(Number(r.importId));
  assert.deepEqual(out, { found: true, unplaced: 1, unzoned: 2 });
  assert.deepEqual(await state(sony), { lat: null, src: null, off: null, osrc: null, day: "2024-03-10", imp: null });
  assert.equal((await state(gap)).off, null);
  assert.deepEqual(await ti.revertTrackImport(Number(r.importId)), { found: false, unplaced: 0, unzoned: 0 });
});
