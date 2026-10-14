// One camera, two names (lib/deviceMakes.ts), against a real database:
//   - through the real indexer: a file giving its Model without the Make joins
//     the body its model's other files spell in full — in one scan, or later
//     when the first file WITH a Make arrives; a re-index and a revert keep it
//     joined; with no file declaring a Make, nothing is guessed;
//   - the join itself: two makers for one model is a question, not a join; an
//     override keeps its body; ownership is carried or yields; a second run
//     changes nothing.
// Database-backed: runs only with WINNOW_TEST_DATABASE_URL. Models carry this
// run's id — the database is shared with other test files, so every call here
// names its models rather than reading the whole library.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { skipWithoutDb, useTestDatabase } from "../test/db";

useTestDatabase();

let db: typeof import("./db");
let dm: typeof import("./deviceMakes");
const run = `${process.pid}-${Date.now()}`;
const model = (label: string) => `${label} ${run}`;
let rootId: number;
let sessionId: number;
let seq = 0;

before(async () => {
  if (skipWithoutDb) return;
  db = await import("./db");
  dm = await import("./deviceMakes");
  rootId = (await db.one<{ id: number }>(
    "INSERT INTO roots (path, kind, watch) VALUES ($1, 'source', false) RETURNING id",
    [`/makes-test-${run}`],
  ))!.id;
  sessionId = (await db.one<{ id: number }>(
    "INSERT INTO sessions (root_id, name, source_path) VALUES ($1, 'm', $2) RETURNING id",
    [rootId, `/makes-test-${run}/m`],
  ))!.id;
});

after(async () => {
  if (skipWithoutDb) return;
  await db.q("DELETE FROM gear_owners WHERE device LIKE $1", [`% ${run}`]);
  await db.q("DELETE FROM assets WHERE session_id = $1", [sessionId]);
  await db.q("DELETE FROM sessions WHERE id = $1", [sessionId]);
  await db.q("DELETE FROM roots WHERE id = $1", [rootId]);
  await db.pool.end();
});

/** A row as the indexer writes it for a file declaring `make` + `cam`. */
async function row(cam: string, make: string | null, extra: Record<string, string> = {}) {
  seq++;
  const device = make ? `${make} ${cam}` : cam;
  const cols = {
    device,
    camera_model: cam,
    device_source: "exif",
    device_exif: device,
    camera_model_exif: cam,
    ...extra,
  };
  return (await db.one<{ id: number }>(
    `INSERT INTO assets (session_id, abs_path, rel_path, filename, ext, media_type,
                         device, camera_model, device_source, device_exif, camera_model_exif)
     VALUES ($1, $2, $3, $3, '.jpg', 'photo', $4, $5, $6, $7, $8) RETURNING id`,
    [
      sessionId,
      `/makes-test-${run}/m/f${seq}.jpg`,
      `f${seq}.jpg`,
      cols.device,
      cols.camera_model,
      cols.device_source,
      cols.device_exif,
      cols.camera_model_exif,
    ],
  ))!.id;
}

async function get(id: number) {
  return (await db.one<{ device: string | null; device_source: string | null; device_exif: string | null }>(
    "SELECT device, device_source, device_exif FROM assets WHERE id = $1",
    [id],
  ))!;
}

test("through the indexer: the clip joins its stills' body, in either order", { skip: skipWithoutDb }, async () => {
  const { default: sharp } = await import("sharp");
  const { exiftool } = await import("exiftool-vendored");
  const { indexRoot } = await import("./indexer");
  const da = await import("./deviceAttribution");
  const dir = await mkdtemp(path.join(os.tmpdir(), "winnow-makes-"));
  // Its own root and an IGNORED session: no derivative is enqueued, no Redis.
  const root = (await db.one<{ id: number }>(
    "INSERT INTO roots (path, kind, watch) VALUES ($1, 'source', false) RETURNING id",
    [dir],
  ))!.id;
  await db.q(
    "INSERT INTO sessions (root_id, name, source_path, ignored) VALUES ($1, 'x', $2, true)",
    [root, dir],
  );
  const cam = model("Ray-Ban Meta Smart Glasses 2");
  const full = `Meta AI ${cam}`;
  const write = async (name: string, tags: Record<string, string>, colour: string) => {
    const file = path.join(dir, name);
    await sharp({ create: { width: 8, height: 8, channels: 3, background: colour } }).jpeg().toFile(file);
    await exiftool.write(file, tags, { writeArgs: ["-overwrite_original"] });
    return file;
  };
  const byPath = async (file: string) =>
    (await db.one<{ id: number; device: string; device_exif: string }>(
      "SELECT id, device, device_exif FROM assets WHERE abs_path = $1",
      [file],
    ))!;
  try {
    // A clip alone: no file of the library names the maker — nothing guessed.
    const clip = await write("clip.jpg", { Model: cam }, "#111");
    await indexRoot(root);
    assert.equal((await byPath(clip)).device, cam);

    // The first still WITH a Make arrives: the clip indexed before joins it.
    const still = await write("still.jpg", { Make: "Meta AI", Model: cam }, "#222");
    await indexRoot(root);
    assert.deepEqual(
      [(await byPath(still)).device, (await byPath(clip)).device, (await byPath(clip)).device_exif],
      [full, full, full],
    );

    // A new clip in the same scan as nothing else: it joins on its own.
    const clip2 = await write("clip2.jpg", { Model: cam }, "#333");
    await indexRoot(root);
    assert.equal((await byPath(clip2)).device, full);

    // A re-index of a joined clip (its file still has no Make) stays joined.
    const t = new Date((await stat(clip)).mtimeMs + 120_000);
    await utimes(clip, t, t);
    await indexRoot(root);
    assert.equal((await byPath(clip)).device, full);

    // Override, then revert: back to the file's body — the joined spelling.
    const id = (await byPath(clip)).id;
    await da.overrideDevice({ ids: [id], device: "SONY ILCE-6700", cameraModel: "ILCE-6700" });
    await da.revertDevice([id]);
    assert.deepEqual(
      Object.values(await get(id)),
      [full, "exif", full],
    );
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

test("two makers for one model is a question, never a join", { skip: skipWithoutDb }, async () => {
  const cam = model("Q1");
  await row(cam, "ACME");
  await row(cam, "Globex");
  const lone = await row(cam, null);
  const r = await dm.joinMakelessBodies([cam]);
  assert.deepEqual(r.pairs, []);
  assert.deepEqual(r.ambiguous, [{ model: cam, fulls: [`ACME ${cam}`, `Globex ${cam}`], media: 1 }]);
  assert.equal((await get(lone)).device, cam);
});

test("an override keeps its body; a hand-pick of the short name moves; a second run is a no-op", { skip: skipWithoutDb }, async () => {
  const cam = model("X2");
  const full = `Fuji ${cam}`;
  await row(cam, "Fuji");
  const plain = await row(cam, null);
  // Corrected by hand to another camera: its body stays, its file's spelling
  // is canonicalised so a revert lands on the joined name.
  const overridden = await row(cam, null, {
    device: "Other body",
    camera_model: "Other",
    device_source: "override",
  });
  // A hand-pick of the short name (a file that named nothing).
  const picked = await row(cam, null, {
    device_source: "manual",
    device_exif: "",
    camera_model_exif: "",
  });
  const r = await dm.joinMakelessBodies([cam]);
  assert.deepEqual(r.pairs, [{ model: cam, full, media: 2 }]);
  assert.equal(r.moved, 2);
  assert.deepEqual(Object.values(await get(plain)), [full, "exif", full]);
  assert.deepEqual(Object.values(await get(overridden)), ["Other body", "override", full]);
  assert.equal((await get(picked)).device, full);
  const again = await dm.joinMakelessBodies([cam]);
  assert.deepEqual([again.pairs.length, again.moved], [0, 0]);
});

test("whose camera: carried to the full name, or yielding to its own answer", { skip: skipWithoutDb }, async () => {
  const go = await import("./gearOwners");
  const a = model("A3");
  const b = model("B3");
  await row(a, "Meta AI");
  await row(a, null);
  await row(b, "Meta AI");
  await row(b, null);
  await go.setOwner({ device: a, owner: "mine", from: "2026-05-01" });
  await go.setOwner({ device: b, owner: "other", name: "Emeric" });
  await go.setOwner({ device: `Meta AI ${b}`, owner: "mine" });
  const r = await dm.joinMakelessBodies([a, b]);
  assert.deepEqual([r.ownersMoved, r.ownersDropped], [1, 1]);
  const owners = await go.listOwners();
  assert.equal(owners.has(a), false);
  assert.deepEqual(
    [owners.get(`Meta AI ${a}`)?.owner, owners.get(`Meta AI ${a}`)?.owned_from],
    ["mine", "2026-05-01"],
  );
  assert.equal(owners.has(b), false);
  assert.equal(owners.get(`Meta AI ${b}`)?.owner, "mine");
});

test("the route previews and applies only on an explicit ask", { skip: skipWithoutDb }, async () => {
  const route = await import("../app/api/pipeline/device-makes/route");
  const res = await route.GET();
  assert.equal(res.status, 200);
  const body = (await res.json()) as { pairs: unknown[]; ambiguous: unknown[] };
  assert.ok(Array.isArray(body.pairs) && Array.isArray(body.ambiguous));
  const post = (b: unknown) =>
    route.POST(new NextRequest("http://x/api/pipeline/device-makes", { method: "POST", body: JSON.stringify(b) }));
  assert.equal((await post({})).status, 400);
});
