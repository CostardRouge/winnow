// Camera-body writes against a real database, and the indexer guard that makes
// them last (cf. lib/deviceAttribution.ts, migration 0048):
//   - fill never touches a body a file declared;
//   - an override replaces it, is idempotent, and SURVIVES a re-index of the
//     file — even after the file's own Model changed — while device_exif keeps
//     following the file;
//   - revert restores the file's current value, or no body where it names none;
//   - the route refuses an override by folder or without a body.
// Database-backed: runs only with WINNOW_TEST_DATABASE_URL (a migrated scratch
// database). The re-index test indexes a real EXIF-tagged JPEG in an IGNORED
// session, so the indexer enqueues nothing and no Redis is needed.
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { skipWithoutDb, useTestDatabase } from "../test/db";

useTestDatabase({ GEOCODE_ENABLED: "false" });

let db: typeof import("./db");
let da: typeof import("./deviceAttribution");
let route: typeof import("../app/api/pipeline/device-attribution/route");
let rootId: number;
let sessionId: number;
let seq = 0;

before(async () => {
  if (skipWithoutDb) return;
  db = await import("./db");
  da = await import("./deviceAttribution");
  route = await import("../app/api/pipeline/device-attribution/route");
  rootId = (await db.one<{ id: number }>(
    "INSERT INTO roots (path, kind, watch) VALUES ('/device-test', 'source', false) RETURNING id",
  ))!.id;
  sessionId = (await db.one<{ id: number }>(
    "INSERT INTO sessions (root_id, name, source_path) VALUES ($1, 'dt', '/device-test/dt') RETURNING id",
    [rootId],
  ))!.id;
});

beforeEach(async () => {
  if (skipWithoutDb) return;
  await db.q("DELETE FROM assets WHERE session_id = $1", [sessionId]);
});

after(async () => {
  if (skipWithoutDb) return;
  await db.q(
    "DELETE FROM assets WHERE session_id IN (SELECT id FROM sessions WHERE root_id = $1)",
    [rootId],
  );
  await db.q("DELETE FROM sessions WHERE root_id = $1", [rootId]);
  await db.q("DELETE FROM roots WHERE id = $1", [rootId]);
  const { closeExiftool } = await import("./extract");
  await closeExiftool();
  await db.pool.end();
});

/** A row as the indexer would have left it: from EXIF, or naming nothing. */
async function asset(device: string | null, model: string | null): Promise<number> {
  seq++;
  return (await db.one<{ id: number }>(
    `INSERT INTO assets (session_id, abs_path, rel_path, filename, ext, media_type,
                         captured_at, device, camera_model, device_source,
                         device_exif, camera_model_exif)
     VALUES ($1, $2, $3, $3, 'jpg', 'photo', now(), $4, $5,
             CASE WHEN $4::text IS NOT NULL THEN 'exif' END, $4, $5)
     RETURNING id`,
    [sessionId, `/device-test/dt/f${seq}.jpg`, `f${seq}.jpg`, device, model],
  ))!.id;
}

const read = async (id: number) =>
  (await db.one<{
    device: string | null;
    camera_model: string | null;
    device_source: string | null;
    device_exif: string | null;
  }>(
    "SELECT device, camera_model, device_source, device_exif FROM assets WHERE id = $1",
    [id],
  ))!;

test("fill never overwrites a body the file declared", { skip: skipWithoutDb }, async () => {
  const exif = await asset("SONY ILCE-7CM2", "ILCE-7CM2");
  const hole = await asset(null, null);
  const r = await da.applyAttribution({ ids: [exif, hole], device: "DJI FC8482", cameraModel: "FC8482" });
  assert.deepEqual(r, { updated: 1, skipped: 1 });
  assert.equal((await read(exif)).device, "SONY ILCE-7CM2");
  assert.deepEqual(await read(hole), {
    device: "DJI FC8482",
    camera_model: "FC8482",
    device_source: "manual",
    device_exif: null,
  });
});

test("override replaces the file's body, keeps what the file says, and is idempotent", { skip: skipWithoutDb }, async () => {
  const id = await asset("SONY ILCE-7CM2", "ILCE-7CM2");
  const body = { ids: [id], device: "SONY ILCE-6700", cameraModel: "ILCE-6700" };
  assert.deepEqual(await da.overrideDevice(body), { updated: 1, skipped: 0 });
  assert.deepEqual(await read(id), {
    device: "SONY ILCE-6700",
    camera_model: "ILCE-6700",
    device_source: "override",
    device_exif: "SONY ILCE-7CM2",
  });
  assert.deepEqual(await da.overrideDevice(body), { updated: 0, skipped: 1 });
});

test("revert restores the file's body, or none where the file names none", { skip: skipWithoutDb }, async () => {
  const exif = await asset("SONY ILCE-7CM2", "ILCE-7CM2");
  const hole = await asset(null, null);
  await da.overrideDevice({ ids: [exif], device: "SONY ILCE-6700", cameraModel: "ILCE-6700" });
  await da.applyAttribution({ ids: [hole], device: "DJI FC8482", cameraModel: "FC8482" });
  assert.deepEqual(await da.revertDevice([exif, hole]), { updated: 2, skipped: 0 });
  assert.deepEqual(await read(exif), {
    device: "SONY ILCE-7CM2",
    camera_model: "ILCE-7CM2",
    device_source: "exif",
    device_exif: "SONY ILCE-7CM2",
  });
  assert.deepEqual(await read(hole), {
    device: null,
    camera_model: null,
    device_source: null,
    device_exif: null,
  });
  // Nothing left to revert: a body read off the file stays as it is.
  assert.deepEqual(await da.revertDevice([exif]), { updated: 0, skipped: 1 });
});

test("the route refuses an override by folder or without a body", { skip: skipWithoutDb }, async () => {
  const post = (body: unknown) =>
    route.POST(
      new NextRequest("http://x/api/pipeline/device-attribution", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
  assert.equal((await post({ session_id: sessionId, device: "X", mode: "override" })).status, 400);
  assert.equal((await post({ ids: [1], mode: "override" })).status, 400);
  assert.equal((await post({ session_id: sessionId, mode: "revert" })).status, 400);
});

test("an override survives a re-index, even after the file's own Model changed", { skip: skipWithoutDb }, async () => {
  const { default: sharp } = await import("sharp");
  const { exiftool } = await import("exiftool-vendored");
  const { indexRoot } = await import("./indexer");
  const dir = await mkdtemp(path.join(os.tmpdir(), "winnow-device-"));
  // Its own root, and an IGNORED session for its folder: the indexer then
  // enqueues no derivative, so the test needs no Redis.
  const root = (await db.one<{ id: number }>(
    "INSERT INTO roots (path, kind, watch) VALUES ($1, 'source', false) RETURNING id",
    [dir],
  ))!.id;
  await db.q(
    "INSERT INTO sessions (root_id, name, source_path, ignored) VALUES ($1, 'x', $2, true)",
    [root, dir],
  );
  try {
    const file = path.join(dir, "DSC00001.JPG");
    await sharp({ create: { width: 8, height: 8, channels: 3, background: "#888" } }).jpeg().toFile(file);
    await exiftool.write(file, { Make: "SONY", Model: "ILCE-7CM2" }, { writeArgs: ["-overwrite_original"] });
    const touch = async () => {
      const t = new Date((await stat(file)).mtimeMs + 120_000);
      await utimes(file, t, t);
    };
    const row = async () =>
      (await db.one<{
        id: number;
        device: string | null;
        device_source: string | null;
        device_exif: string | null;
      }>(
        "SELECT id, device, device_source, device_exif FROM assets WHERE abs_path = $1",
        [file],
      ))!;

    await indexRoot(root);
    const first = await row();
    assert.deepEqual(
      [first.device, first.device_source, first.device_exif],
      ["SONY ILCE-7CM2", "exif", "SONY ILCE-7CM2"],
    );

    await da.overrideDevice({ ids: [first.id], device: "SONY ILCE-6700", cameraModel: "ILCE-6700" });
    await touch();
    await indexRoot(root);
    let r = await row();
    assert.deepEqual([r.device, r.device_source], ["SONY ILCE-6700", "override"]);

    // The file itself changes: the correction holds, device_exif follows it.
    await exiftool.write(file, { Model: "ILCE-7M4" }, { writeArgs: ["-overwrite_original"] });
    await touch();
    await indexRoot(root);
    r = await row();
    assert.deepEqual(
      [r.device, r.device_source, r.device_exif],
      ["SONY ILCE-6700", "override", "SONY ILCE-7M4"],
    );

    // Revert restores what the file says NOW, not what it said then.
    await da.revertDevice([r.id]);
    await touch();
    await indexRoot(root);
    r = await row();
    assert.deepEqual([r.device, r.device_source], ["SONY ILCE-7M4", "exif"]);
  } finally {
    await db.q(
      "DELETE FROM assets WHERE session_id IN (SELECT id FROM sessions WHERE root_id = $1)",
      [root],
    );
    await db.q("DELETE FROM sessions WHERE root_id = $1", [root]);
    await db.q("DELETE FROM roots WHERE id = $1", [root]);
    await rm(dir, { recursive: true, force: true });
  }
});
