// Migration 0061 + lib/captureCorrections.ts against a real database: a clock
// correction is a shift beside what the file says, it survives every writer
// that re-reads the file, it moves only the ticked bodies (whole piles and
// pairs), and Undo puts back exactly what it replaced. Database-backed: runs
// only with WINNOW_TEST_DATABASE_URL (a migrated scratch database).
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { skipWithoutDb, useTestDatabase } from "../test/db";

useTestDatabase();

let cc: typeof import("./captureCorrections");
let db: typeof import("./db");
let rootId: number;
let finalsRootId: number;
let sessionId: number;
let seq = 0;

const SONY = "SONY ILCE-7CM2";
const PHONE = "Apple iPhone 15 Pro";
const NINE_H = 9 * 3600;

before(async () => {
  if (skipWithoutDb) return;
  cc = await import("./captureCorrections");
  db = await import("./db");
  rootId = (await db.one<{ id: number }>(
    "INSERT INTO roots (path, kind, watch) VALUES ('/capture-shift-test', 'source', false) RETURNING id",
  ))!.id;
  finalsRootId = (await db.one<{ id: number }>(
    "INSERT INTO roots (path, kind, watch) VALUES ('/capture-shift-finals', 'finals', false) RETURNING id",
  ))!.id;
  sessionId = (await db.one<{ id: number }>(
    "INSERT INTO sessions (root_id, name, source_path) VALUES ($1, 'Mt Coot-tha', '/capture-shift-test/s') RETURNING id",
    [rootId],
  ))!.id;
});

beforeEach(async () => {
  if (skipWithoutDb) return;
  await db.q("DELETE FROM capture_corrections");
  await db.q("DELETE FROM assets WHERE session_id = $1", [sessionId]);
});

after(async () => {
  if (skipWithoutDb) return;
  await db.q("DELETE FROM capture_corrections");
  await db.q("DELETE FROM roots WHERE id = ANY($1)", [[rootId, finalsRootId]]);
  await db.pool.end();
});

type Seed = {
  at: string;
  device?: string | null;
  source?: "exif" | "exif-wall" | "file";
  offset?: number | null;
  session?: number;
  name?: string;
};

async function seed(s: Seed): Promise<number> {
  seq++;
  const name = s.name ?? `DSC${seq}.ARW`;
  const row = await db.one<{ id: number }>(
    `INSERT INTO assets (session_id, abs_path, rel_path, filename, ext, media_type, device,
                         captured_at, captured_at_source, capture_offset_min,
                         capture_offset_source, file_mtime)
     VALUES ($1, $2, $3, $3, 'arw', 'photo', $4, $5, $6, $7, $8, '2026-11-20T08:00:00Z')
     RETURNING id`,
    [
      s.session ?? sessionId,
      `/capture-shift-test/s/${seq}/${name}`,
      name,
      s.device === undefined ? SONY : s.device,
      s.at,
      s.source ?? "exif-wall",
      s.offset ?? null,
      s.offset != null ? "gps" : null,
    ],
  );
  return row!.id;
}

const read = (id: number) =>
  db.one<{ at: string; file: string; day: string; shift: number | null; corr: number | null }>(
    `SELECT to_char(captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS at,
            to_char(captured_at_file AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS file,
            capture_date::text AS day, capture_shift_s AS shift,
            capture_correction_id::int AS corr
       FROM assets WHERE id = $1`,
    [id],
  ) as Promise<{ at: string; file: string; day: string; shift: number | null; corr: number | null }>;

const who = { userId: null, via: "session" as const };

test("a shift moves the moment and the day, and the file's time stays beside it", { skip: skipWithoutDb }, async () => {
  const id = await seed({ at: "2026-11-11T20:41:00Z" });
  const plan = await cc.planCorrection({ ids: [id], mode: "shift", shiftS: NINE_H });
  assert.equal(plan.moving, 1);
  assert.deepEqual(plan.days, [
    { date: "2026-11-11", before: 1, after: 0 },
    { date: "2026-11-12", before: 0, after: 1 },
  ]);
  assert.equal((await read(id)).shift, null, "a preview writes nothing");

  await cc.applyCorrection({ ids: [id], mode: "shift", shiftS: NINE_H }, who);
  const r = await read(id);
  assert.equal(r.at, "2026-11-12T05:41:00");
  assert.equal(r.file, "2026-11-11T20:41:00");
  assert.equal(r.day, "2026-11-12");
  assert.equal(r.shift, NINE_H);
});

test("the correction survives the writers that re-read the file", { skip: skipWithoutDb }, async () => {
  const id = await seed({ at: "2026-11-11T20:41:00Z" });
  await cc.applyCorrection({ ids: [id], mode: "shift", shiftS: NINE_H }, who);

  // A writer that predates 0061 (or a re-index of an unchanged date) sets
  // captured_at to what the file says: the shift is re-applied on top.
  await db.q("UPDATE assets SET captured_at = '2026-11-11T20:41:00Z' WHERE id = $1", [id]);
  assert.equal((await read(id)).at, "2026-11-12T05:41:00");

  // The indexer and the capture-day re-read write the file's time explicitly;
  // a file whose date really changed carries the shift along.
  await db.q("UPDATE assets SET captured_at_file = '2026-11-11T21:00:00Z' WHERE id = $1", [id]);
  const r = await read(id);
  assert.equal(r.file, "2026-11-11T21:00:00");
  assert.equal(r.at, "2026-11-12T06:00:00");
});

test("only the ticked bodies move; piles and pairs move whole", { skip: skipWithoutDb }, async () => {
  const a = await seed({ at: "2026-11-11T20:41:00Z" });
  const b = await seed({ at: "2026-11-11T20:41:01Z" });
  const c = await seed({ at: "2026-11-11T20:41:02Z" });
  const raw = await seed({ at: "2026-11-11T21:10:00Z" });
  const jpg = await seed({ at: "2026-11-11T21:10:00Z", name: "DSC9.JPG" });
  const phone = await seed({ at: "2026-11-12T05:38:35Z", device: PHONE, source: "exif", offset: 600 });

  const burst = await db.one<{ id: number }>(
    "INSERT INTO bursts (session_id, device, started_at, ended_at, member_count) VALUES ($1, $2, '2026-11-11T20:41:00Z', '2026-11-11T20:41:02Z', 3) RETURNING id",
    [sessionId, SONY],
  );
  await db.q("UPDATE assets SET burst_id = $1 WHERE id = ANY($2)", [burst!.id, [a, b, c]]);
  const group = await db.one<{ id: number }>(
    "INSERT INTO asset_groups (session_id) VALUES ($1) RETURNING id",
    [sessionId],
  );
  await db.q("UPDATE assets SET group_id = $1, group_role = CASE WHEN id = $2 THEN 'companion' ELSE 'primary' END WHERE id = ANY($3)", [
    group!.id,
    raw,
    [raw, jpg],
  ]);

  // The selection names one pile frame, the JPEG of the pair and the phone.
  const req = { ids: [b, jpg, phone], devices: [SONY], mode: "shift" as const, shiftS: NINE_H };
  const plan = await cc.planCorrection(req);
  assert.equal(plan.selected, 3);
  assert.equal(plan.expanded, 6, "the pile and the pair's RAW join the selection");
  assert.equal(plan.moving, 5);
  assert.deepEqual(
    plan.bodies.map((x) => [x.device, x.count, x.moving]),
    [[SONY, 5, true], [PHONE, 1, false]],
  );

  await cc.applyCorrection(req, who);
  for (const id of [a, b, c, raw, jpg]) assert.equal((await read(id)).shift, NINE_H);
  assert.equal((await read(phone)).shift, null, "the reference body stays put");

  const span = await db.one<{ lo: string; hi: string }>(
    `SELECT to_char(captured_at_min AT TIME ZONE 'UTC', 'HH24:MI') AS lo,
            to_char(captured_at_max AT TIME ZONE 'UTC', 'HH24:MI') AS hi
       FROM sessions WHERE id = $1`,
    [sessionId],
  );
  assert.deepEqual(span, { lo: "05:38", hi: "06:10" }, "the session's span follows");
  const pile = await db.one<{ lo: string }>(
    "SELECT to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') AS lo FROM bursts WHERE id = $1",
    [burst!.id],
  );
  assert.equal(pile!.lo, "2026-11-12 05:41");
});

test("setting one frame's local time shifts the others by the same amount", { skip: skipWithoutDb }, async () => {
  // A zoned instant whose day is filed in Brisbane (UTC+10): its local wall
  // clock is 05:41 on the 12th. The photographer says it was 07:41.
  const zoned = await seed({ at: "2026-11-11T19:41:00Z", source: "exif", offset: 600 });
  const wall = await seed({ at: "2026-11-11T20:00:00Z" });
  await cc.applyCorrection(
    { ids: [zoned, wall], mode: "set", set: { id: zoned, local: "2026-11-12T07:41" } },
    who,
  );
  assert.equal((await read(zoned)).shift, 2 * 3600);
  assert.equal((await read(zoned)).at, "2026-11-11T21:41:00");
  assert.equal((await read(wall)).at, "2026-11-11T22:00:00");

  await assert.rejects(
    cc.planCorrection({ ids: [wall], mode: "set", set: { id: zoned, local: "2026-11-12T07:41" } }),
    cc.CorrectionError,
  );
  await assert.rejects(
    cc.planCorrection({ ids: [wall], mode: "set", set: { id: wall, local: "2026-02-31T07:41" } }),
    cc.CorrectionError,
  );
});

test("Undo puts back what it replaced, and leaves what a later gesture moved", { skip: skipWithoutDb }, async () => {
  const x = await seed({ at: "2026-11-11T20:41:00Z" });
  const y = await seed({ at: "2026-11-11T20:50:00Z" });
  const first = await cc.applyCorrection({ ids: [x, y], mode: "shift", shiftS: NINE_H }, who);
  const second = await cc.applyCorrection({ ids: [x], mode: "shift", shiftS: 3600 }, who);
  assert.equal((await read(x)).shift, 10 * 3600, "a second gesture adds to the first");

  // Undoing the first: x now belongs to the second gesture and is left alone.
  const u1 = await cc.undoCorrection(first.id);
  assert.deepEqual(u1, { restored: 1, skipped: 1 });
  assert.equal((await read(y)).shift, null);
  assert.equal((await read(x)).shift, 10 * 3600);
  await assert.rejects(cc.undoCorrection(first.id), cc.CorrectionError);

  // Undoing the second puts x back to +9 h — the first's value, though the
  // first was undone: Undo restores what it replaced, nothing more.
  const u2 = await cc.undoCorrection(second.id);
  assert.deepEqual(u2, { restored: 1, skipped: 0 });
  const rx = await read(x);
  assert.equal(rx.shift, NINE_H);
  assert.equal(rx.corr, null, "no standing gesture owns it any more");

  const list = await cc.listCorrections();
  assert.equal(list.length, 2);
  assert.ok(list.every((c) => c.undone_at != null));
});

test("a stacked Undo hands the row back to the gesture before it", { skip: skipWithoutDb }, async () => {
  const x = await seed({ at: "2026-11-11T20:41:00Z" });
  const first = await cc.applyCorrection({ ids: [x], mode: "shift", shiftS: NINE_H }, who);
  const second = await cc.applyCorrection({ ids: [x], mode: "shift", shiftS: 60 }, who);
  await cc.undoCorrection(second.id);
  assert.equal((await read(x)).corr, first.id);
  assert.deepEqual(await cc.undoCorrection(first.id), { restored: 1, skipped: 0 });
  assert.equal((await read(x)).at, "2026-11-11T20:41:00");
});

test("revert goes back to the file, and is a gesture of its own", { skip: skipWithoutDb }, async () => {
  const x = await seed({ at: "2026-11-11T20:41:00Z" });
  await cc.applyCorrection({ ids: [x], mode: "shift", shiftS: NINE_H }, who);
  const back = await cc.applyCorrection({ ids: [x], mode: "revert" }, who);
  assert.equal((await read(x)).at, "2026-11-11T20:41:00");
  await assert.rejects(
    cc.applyCorrection({ ids: [x], mode: "revert" }, who),
    /Nothing would move/,
  );
  await cc.undoCorrection(back.id);
  assert.equal((await read(x)).shift, NINE_H);
});

test("the capture-day backfill does not take a corrected 'file' row for a mislabelled one", { skip: skipWithoutDb }, async () => {
  const cd = await import("./captureDays");
  const x = await seed({ at: "2026-11-20T08:00:00Z", source: "file" }); // = its mtime
  await cc.applyCorrection({ ids: [x], mode: "shift", shiftS: -3600 }, who);
  const report = await cd.runCaptureDayBackfill({ apply: true, reread: false });
  assert.equal(report.relabelled, 0);
  const src = await db.one<{ s: string }>("SELECT captured_at_source AS s FROM assets WHERE id = $1", [x]);
  assert.equal(src!.s, "file");
});

test("reconcile matches an edit to its source on what the FILES say", { skip: skipWithoutDb }, async () => {
  const rc = await import("./reconcile");
  // Two captures share a basename; the export carries the first one's date.
  const a = await seed({ at: "2026-11-11T20:41:00Z", name: "DSC7777.ARW" });
  await seed({ at: "2026-03-02T10:00:00Z", name: "DSC7777.ARW" });
  const finals = await db.one<{ id: number }>(
    "INSERT INTO sessions (root_id, name, source_path) VALUES ($1, 'f', '/capture-shift-finals/f') RETURNING id",
    [finalsRootId],
  );
  const fin = await seed({ at: "2026-11-11T20:41:00Z", name: "DSC7777.jpg", session: finals!.id });
  // The source's clock is corrected afterwards.
  await cc.applyCorrection({ ids: [a], mode: "shift", shiftS: NINE_H }, who);
  await rc.reconcileEdits({ rootId: finalsRootId });
  const linked = await db.one<{ o: number | null }>(
    "SELECT original_asset_id::int AS o FROM assets WHERE id = $1",
    [fin],
  );
  assert.equal(linked!.o, a);
  await db.q("DELETE FROM sessions WHERE id = $1", [finals!.id]);
});
