// lib/mirrorRepair.ts against a real database: a placed group the GPS
// write-back mirrored is found from the cameras' fixes of the same hours and
// put back, its written originals queued for a rewrite; a group that is right
// is left alone; a group with no evidence is listed and never guessed.
// Database-backed: runs only with WINNOW_TEST_DATABASE_URL. Invented fixtures;
// the queues are stubbed.
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { skipWithoutDb, useTestDatabase } from "../test/db";

useTestDatabase();

let db: typeof import("./db");
let mr: typeof import("./mirrorRepair");
let rootId: number;
let sessionId: number;
let otherSession: number;
let seq = 0;
const queued = { gpswrite: [] as number[], geocode: [] as number[] };
const deps = {
  enqueueGpsWriteBulk: async (ids: number[]) => void queued.gpswrite.push(...ids),
  enqueueGeocodeBulk: async (ids: number[]) => void queued.geocode.push(...ids),
};

before(async () => {
  if (skipWithoutDb) return;
  db = await import("./db");
  mr = await import("./mirrorRepair");
  await db.q("DELETE FROM assets WHERE session_id IN (SELECT s.id FROM sessions s JOIN roots r ON r.id = s.root_id WHERE r.path = '/mirror-test')");
  await db.q("DELETE FROM roots WHERE path = '/mirror-test'");
  const root = await db.one<{ id: number }>(
    "INSERT INTO roots (path, kind, watch) VALUES ('/mirror-test', 'source', false) RETURNING id",
  );
  rootId = root!.id;
  const s1 = await db.one<{ id: number }>(
    "INSERT INTO sessions (root_id, name, source_path) VALUES ($1, 'streaky bay', '/mirror-test/sony') RETURNING id",
    [rootId],
  );
  const s2 = await db.one<{ id: number }>(
    "INSERT INTO sessions (root_id, name, source_path) VALUES ($1, 'iphone', '/mirror-test/iphone') RETURNING id",
    [rootId],
  );
  sessionId = Number(s1!.id);
  otherSession = Number(s2!.id);
});

beforeEach(async () => {
  if (skipWithoutDb) return;
  // Only this file's rows count: every other test's located rows live in
  // other years, outside any window here.
  await db.q("DELETE FROM assets WHERE session_id = ANY($1)", [[sessionId, otherSession]]);
  queued.gpswrite = [];
  queued.geocode = [];
});

after(async () => {
  if (skipWithoutDb) return;
  await db.q("DELETE FROM assets WHERE session_id = ANY($1)", [[sessionId, otherSession]]);
  await db.q("DELETE FROM roots WHERE id = $1", [rootId]);
  await db.pool.end();
});

async function media(o: {
  session?: number;
  at: string;
  gps: { lat: number; lon: number };
  source: string | null;
  written?: string;
  video?: boolean;
}) {
  seq++;
  const row = await db.one<{ id: number }>(
    `INSERT INTO assets (session_id, abs_path, rel_path, filename, ext, media_type,
                         captured_at, gps, gps_source, gps_write_status, place_city)
     VALUES ($1, $2, $3, $3, $4, $5, $6::timestamptz, $7::jsonb, $8, $9, 'Lianyungang')
     RETURNING id`,
    [o.session ?? sessionId, `/mirror-test/F${seq}`, `F${seq}`, o.video ? ".mp4" : ".hif",
     o.video ? "video" : "photo", o.at, JSON.stringify(o.gps), o.source, o.written ?? "skipped"],
  );
  return Number(row!.id);
}

const pos = (id: number) =>
  db.one<{ lat: number; lon: number; w: string; city: string | null }>(
    "SELECT gps_lat AS lat, gps_lon AS lon, gps_write_status AS w, place_city AS city FROM assets WHERE id = $1",
    [id],
  );

// Streaky Bay, South Australia, and its mirror in the Pacific.
const TRUE = { lat: -32.79422, lon: 134.21336 };
const MIRROR = { lat: 32.79422, lon: 134.21336 };
const DAY = "2031-01-05";

test("a mirrored folder is found from the phone's fixes and put back", { skip: skipWithoutDb }, async () => {
  await media({ session: otherSession, at: `${DAY}T03:00:00Z`, gps: { lat: -32.79, lon: 134.21 }, source: null });
  const a = await media({ at: `${DAY}T04:00:00Z`, gps: MIRROR, source: "manual", written: "ready" });
  const b = await media({ at: `${DAY}T04:05:00Z`, gps: MIRROR, source: "manual", written: "ready" });

  const preview = await mr.repairMirrored(false, deps);
  const g = preview.groups.find((x) => x.sessionId === sessionId)!;
  assert.equal(g.verdict, "mirrored");
  assert.deepEqual(g.to, TRUE);
  assert.equal(preview.mirrored, 2);
  assert.equal(preview.filesToRewrite, 2);
  assert.equal((await pos(a))!.lat, MIRROR.lat, "a preview writes nothing");

  const done = await mr.repairMirrored(true, deps);
  assert.equal(done.filesToRewrite, 2);
  const after = await pos(a);
  assert.deepEqual({ lat: after!.lat, lon: after!.lon, w: after!.w, city: after!.city },
    { lat: TRUE.lat, lon: TRUE.lon, w: "pending", city: null });
  assert.deepEqual(queued.gpswrite.sort(), [a, b].sort());
  assert.deepEqual(queued.geocode.sort(), [a, b].sort());
});

test("a Breton folder mirrored across Greenwich is found too (415 km, not 7 000)", { skip: skipWithoutDb }, async () => {
  const at = "2031-08-12";
  await media({ session: otherSession, at: `${at}T07:00:00Z`, gps: { lat: 48.6519, lon: -2.8246 }, source: null });
  const a = await media({ at: `${at}T08:00:00Z`, gps: { lat: 48.652163, lon: 2.830138 }, source: "manual", written: "ready" });
  const r = await mr.repairMirrored(true, deps);
  assert.equal(r.groups.find((x) => x.sessionId === sessionId)!.verdict, "mirrored");
  assert.equal((await pos(a))!.lon, -2.830138);
});

test("a folder placed right is left alone", { skip: skipWithoutDb }, async () => {
  await media({ session: otherSession, at: `${DAY}T03:00:00Z`, gps: { lat: -32.79, lon: 134.21 }, source: null });
  const a = await media({ at: `${DAY}T04:00:00Z`, gps: TRUE, source: "inferred" });
  const r = await mr.repairMirrored(true, deps);
  assert.equal(r.groups.some((x) => x.sessionId === sessionId), false);
  assert.equal((await pos(a))!.lat, TRUE.lat);
  assert.deepEqual(queued.gpswrite, []);
});

test("a right row whose file went N/E gets its original rewritten", { skip: skipWithoutDb }, async () => {
  await media({ session: otherSession, at: `${DAY}T03:00:00Z`, gps: { lat: -32.79, lon: 134.21 }, source: null });
  const a = await media({ at: `${DAY}T04:00:00Z`, gps: TRUE, source: "manual", written: "ready" });
  const clip = await media({ at: `${DAY}T04:00:00Z`, gps: TRUE, source: "manual", written: "ready", video: true });
  const r = await mr.repairMirrored(true, deps);
  assert.equal(r.mirrored, 0);
  // The clip's GPSCoordinates string kept its sign: its file is right.
  assert.deepEqual(queued.gpswrite, [a]);
  assert.equal((await pos(clip))!.w, "ready");
});

test("with no camera fix in its hours, a group is listed and never guessed", { skip: skipWithoutDb }, async () => {
  const a = await media({ at: `${DAY}T04:00:00Z`, gps: MIRROR, source: "manual", written: "ready" });
  // An inferred row elsewhere is not evidence: it may be mirrored too.
  await media({ session: otherSession, at: `${DAY}T04:30:00Z`, gps: TRUE, source: "inferred" });
  const r = await mr.repairMirrored(true, deps);
  const g = r.groups.find((x) => x.sessionId === sessionId)!;
  assert.equal(g.verdict, "no_evidence");
  assert.equal((await pos(a))!.lat, MIRROR.lat);
});
