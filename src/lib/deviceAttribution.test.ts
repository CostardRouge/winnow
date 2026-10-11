// Camera-body writes against a real database, and the indexer guard that makes
// them last (cf. lib/deviceAttribution.ts, migration 0048):
//   - fill never touches a body a file declared;
//   - an override replaces it, is idempotent, and SURVIVES a re-index of the
//     file — even after the file's own Model changed — while device_exif keeps
//     following the file;
//   - revert restores the file's current value, or no body where it names none;
//   - the route refuses an override by folder or without a body;
//   - a suggestion-mode apply gives each medium ITS OWN folder's body;
//   - the folder aggregate (the vote in SQL) agrees with the per-medium vote
//     (the same vote in JS) — the two engines share the weights and patterns;
//   - the backlog reads one half of the library and never an ignored folder;
//   - a camera named by hand / "not a camera" (0051) leaves the backlog, never
//     touches a body a file declares, reuses a name, refuses a real body's
//     name, spreads as 'named' through a fill, reverts, survives a re-index
//     and yields to a file that later names a body; the filter reads both.
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
  await db.q(
    "DELETE FROM assets WHERE session_id IN (SELECT id FROM sessions WHERE root_id = $1)",
    [rootId],
  );
  await db.q("DELETE FROM sessions WHERE root_id = $1 AND id <> $2", [rootId, sessionId]);
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

/** A folder of its own under the test root. */
async function folder(name: string): Promise<number> {
  return (await db.one<{ id: number }>(
    "INSERT INTO sessions (root_id, name, source_path) VALUES ($1, $2, $3) RETURNING id",
    [rootId, name, `/device-test/${name}`],
  ))!.id;
}

/** A medium in a given folder, named, with an optional body and .SRT. */
async function medium(
  session: number,
  filename: string,
  opts: {
    device?: string;
    model?: string;
    video?: boolean;
    srtSamples?: number;
    companion?: boolean;
    trashed?: boolean;
  } = {},
): Promise<number> {
  const id = (await db.one<{ id: number }>(
    `INSERT INTO assets (session_id, abs_path, rel_path, filename, ext, media_type,
                         captured_at, device, camera_model, device_source,
                         device_exif, camera_model_exif, group_role, deleted_at)
     VALUES ($1, $2, $3, $3, $4, $5, now(), $6, $7,
             CASE WHEN $6::text IS NOT NULL THEN 'exif' END, $6, $7, $8,
             CASE WHEN $9 THEN now() END)
     RETURNING id`,
    [
      session,
      `/device-test/${session}/${filename}`,
      filename,
      opts.video ? "mp4" : "jpg",
      opts.video ? "video" : "photo",
      opts.device ?? null,
      opts.model ?? null,
      opts.companion ? "companion" : null,
      !!opts.trashed,
    ],
  ))!.id;
  if (opts.srtSamples != null)
    await db.q(
      `INSERT INTO asset_sidecars (asset_id, abs_path, rel_path, filename, kind, sample_count)
       VALUES ($1, $2, $3, $3, 'srt', $4)`,
      [id, `/device-test/${session}/${filename}.SRT`, `${filename}.SRT`, opts.srtSamples],
    );
  return id;
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

test("a suggestion-mode apply gives each medium its own folder's body", { skip: skipWithoutDb }, async () => {
  const sony = await folder("sony-day");
  const dji = await folder("dji-day");
  const none = await folder("no-sibling");
  await medium(sony, "DSC1.JPG", { device: "SONY ILCE-7CM2", model: "ILCE-7CM2" });
  await medium(dji, "DJI_0001.JPG", { device: "DJI FC8482", model: "FC8482" });
  const a = await medium(sony, "C0001.MP4", { video: true });
  const b = await medium(dji, "DJI_0002.MP4", { video: true });
  const c = await medium(none, "clip.mp4", { video: true });
  assert.deepEqual(await da.applyAttribution({ ids: [a, b, c] }), { updated: 2, skipped: 1 });
  assert.deepEqual(await read(a), {
    device: "SONY ILCE-7CM2",
    camera_model: "ILCE-7CM2",
    device_source: "derived",
    device_exif: null,
  });
  assert.equal((await read(b)).device, "DJI FC8482");
  assert.equal((await read(c)).device, null);
  // Re-running it is free: nothing is a hole any more but `c`, which has no
  // proposal.
  assert.deepEqual(await da.applyAttribution({ ids: [a, b, c] }), { updated: 0, skipped: 3 });
});

test("the folder aggregate and the per-medium vote agree", { skip: skipWithoutDb }, async () => {
  const f = await folder("dji drone flights");
  await medium(f, "DJI_0001.JPG", { device: "DJI FC8482", model: "FC8482" });
  // Flight log + .SRT + maker name + sibling + folder name: 11, confident.
  await medium(f, "DJI_0002.MP4", { video: true, srtSamples: 120 });
  // An .SRT that parsed nothing (a subtitle file) + sibling + folder: 6.
  await medium(f, "holiday.mp4", { video: true, srtSamples: 0 });
  // Sibling + folder only: 4, below the bar.
  await medium(f, "IMG_1.mp4", { video: true });
  // Neither a companion nor a trashed medium is a candidate.
  await medium(f, "DJI_0003.MP4", { video: true, companion: true });
  await medium(f, "DJI_0004.MP4", { video: true, trashed: true });

  const card = (await da.listFolders()).find((x) => x.session_id === f);
  const { items, total } = await da.listCandidates({ sessionId: f });
  assert.ok(card);
  assert.equal(card.total, 3);
  assert.equal(total, 3);
  assert.deepEqual(
    items.map((i) => [i.filename, i.score]).sort(),
    [["DJI_0002.MP4", 11], ["IMG_1.mp4", 4], ["holiday.mp4", 6]],
  );
  // SQL counted what JS scored.
  assert.equal(card.confident, items.filter((i) => i.confident).length);
  assert.equal(card.confident, 2);
  assert.equal(card.suggested_device, "DJI FC8482");
  // Signals carried by more than half of the three: sidecar (2), sibling and
  // folder (3) — not the flight log or the maker name (1 each).
  assert.deepEqual(card.signals, ["sidecar", "sibling", "folder"]);

  // The "confident only" folder write reaches exactly the media the per-medium
  // vote ticks.
  const r = await da.applyFolder({ sessionId: f, minScore: da.CONFIDENT_SCORE });
  assert.deepEqual(r, { updated: 2, skipped: 1 });
  assert.equal((await da.countUnattributed({ sessionId: f })), 1);
});

test("the backlog reads one half of the library, and never an ignored folder", { skip: skipWithoutDb }, async () => {
  // Incoming is the test root (kind 'source'); the Gallery is a `finals` root
  // of its own, cleaned up here since the shared `after` only knows rootId.
  const finals = (await db.one<{ id: number }>(
    "INSERT INTO roots (path, kind, watch) VALUES ('/device-test-finals', 'finals', false) RETURNING id",
  ))!.id;
  try {
    const inc = await folder("incoming-day");
    const ign = await folder("ignored-day");
    await db.q("UPDATE sessions SET ignored = true WHERE id = $1", [ign]);
    const gal = (await db.one<{ id: number }>(
      "INSERT INTO sessions (root_id, name, source_path) VALUES ($1, 'g', '/device-test-finals/g') RETURNING id",
      [finals],
    ))!.id;
    await medium(inc, "a.mp4", { video: true });
    await medium(ign, "b.mp4", { video: true });
    await medium(gal, "c.jpg");

    // Membership, never library-wide counts: other test files share the
    // database and run alongside (docs/memory/testing-and-ci.md).
    const ids = async (source: "incoming" | "gallery" | "all") =>
      (await da.listFolders({ source })).map((f) => f.session_id);
    const incoming = await ids("incoming");
    const gallery = await ids("gallery");
    const all = await ids("all");
    assert.ok(incoming.includes(inc) && !incoming.includes(gal));
    assert.ok(gallery.includes(gal) && !gallery.includes(inc));
    assert.ok(all.includes(inc) && all.includes(gal));
    // The ignored folder is in no half at all…
    for (const half of [incoming, gallery, all]) assert.ok(!half.includes(ign));
    assert.equal(await da.countUnattributed({ sessionId: ign }), 0);
    // …and the per-half counts agree with the per-half listings.
    assert.equal(await da.countUnattributed({ sessionId: gal, source: "incoming" }), 0);
    assert.equal(await da.countUnattributed({ sessionId: gal, source: "gallery" }), 1);
  } finally {
    await db.q(
      "DELETE FROM assets WHERE session_id IN (SELECT id FROM sessions WHERE root_id = $1)",
      [finals],
    );
    await db.q("DELETE FROM sessions WHERE root_id = $1", [finals]);
    await db.q("DELETE FROM roots WHERE id = $1", [finals]);
  }
});

// A name of this run only: other test files share the database and run
// alongside, and names are library-wide.
const uniq = (label: string) => `${label} ${process.pid}-${Date.now()}`;

test("naming or setting aside a folder empties its backlog, and nothing else", { skip: skipWithoutDb }, async () => {
  const pot = await folder("pot-de-depart");
  await medium(pot, "DSC1.ARW", { device: "SONY ILCE-7CM2", model: "ILCE-7CM2" });
  const wa1 = await medium(pot, "WhatsApp Image 1.jpeg");
  const wa2 = await medium(pot, "WhatsApp Image 2.jpeg");
  const emeric = uniq("Appareil d'Emeric");

  // The folder's proposal is the maintainer's own body — the lie this exists
  // to avoid. Naming writes the typed name instead, on the backlog only.
  assert.deepEqual(await da.labelDevice({ sessionId: pot, name: emeric }), { updated: 2, skipped: 0 });
  for (const id of [wa1, wa2])
    assert.deepEqual(
      [(await read(id)).device, (await read(id)).device_source],
      [emeric, "named"],
    );
  assert.equal(await da.countUnattributed({ sessionId: pot }), 0);
  assert.ok(!(await da.listFolders()).some((f) => f.session_id === pot));
  // It is a body now, known as named by hand.
  const body = (await da.listKnownBodies()).find((b) => b.device === emeric);
  assert.ok(body?.named);
  assert.equal((await da.listKnownBodies()).find((b) => b.device === "SONY ILCE-7CM2")?.named, false);

  const shots = await folder("screenshots");
  const png = await medium(shots, "LQRB5637.PNG");
  assert.deepEqual(await da.labelDevice({ sessionId: shots, name: null }), { updated: 1, skipped: 0 });
  assert.deepEqual(await read(png), {
    device: null,
    camera_model: null,
    device_source: "none",
    device_exif: null,
  });
  assert.equal(await da.countUnattributed({ sessionId: shots }), 0);
});

test("by ids, a name or 'not a camera' never touches a body a file declared", { skip: skipWithoutDb }, async () => {
  const exif = await asset("SONY ILCE-7CM2", "ILCE-7CM2");
  const hole = await asset(null, null);
  // The screenshot once assigned to the iPhone by hand.
  const assigned = await asset(null, null);
  await da.applyAttribution({ ids: [assigned], device: "Apple iPhone 15 Pro Max", cameraModel: "iPhone 15 Pro Max" });

  assert.deepEqual(await da.labelDevice({ ids: [exif, hole, assigned], name: null }), { updated: 2, skipped: 1 });
  assert.equal((await read(exif)).device_source, "exif");
  assert.equal((await read(assigned)).device_source, "none");
  assert.equal((await read(assigned)).device, null);
  // Re-running it is free.
  assert.deepEqual(await da.labelDevice({ ids: [hole, assigned], name: null }), { updated: 0, skipped: 2 });
  // And revert puts them back in the backlog: their files name nothing.
  assert.deepEqual(await da.revertDevice([hole, assigned]), { updated: 2, skipped: 0 });
  assert.deepEqual([(await read(hole)).device_source, (await read(hole)).device], [null, null]);
});

test("a name is reused whatever its case, and a real body's name is refused", { skip: skipWithoutDb }, async () => {
  const name = uniq("Photographe du mariage");
  const a = await asset(null, null);
  const b = await asset(null, null);
  await da.labelDevice({ ids: [a], name });
  await da.labelDevice({ ids: [b], name: `  ${name.toUpperCase()}  ` });
  assert.equal((await read(b)).device, name);

  // A string a file declares is a body, not a name: refused, nothing written.
  const real = uniq("SONY ILCE-REAL");
  await asset(real, "ILCE-REAL");
  const c = await asset(null, null);
  await assert.rejects(da.labelDevice({ ids: [c], name: real.toLowerCase() }), da.DeviceNameTaken);
  assert.equal((await read(c)).device, null);

  // A fill to a named camera — picked, or proposed by its folder — stays named.
  const d = await asset(null, null);
  await da.applyAttribution({ ids: [d], device: name });
  assert.equal((await read(d)).device_source, "named");
  const f = await folder("wedding");
  await medium(f, "w1.jpg");
  await da.labelDevice({ sessionId: f, name });
  const e = await medium(f, "w2.jpg");
  assert.deepEqual(await da.applyFolder({ sessionId: f }), { updated: 1, skipped: 0 });
  assert.deepEqual([(await read(e)).device, (await read(e)).device_source], [name, "named"]);
});

test("the route takes name / none by folder or ids, and checks their shape", { skip: skipWithoutDb }, async () => {
  const post = (body: unknown) =>
    route.POST(
      new NextRequest("http://x/api/pipeline/device-attribution", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
  assert.equal((await post({ session_id: sessionId, mode: "name" })).status, 400);
  assert.equal((await post({ ids: [1], mode: "none", device: "X" })).status, 400);
  const real = uniq("SONY ILCE-ROUTE");
  await asset(real, "ILCE-ROUTE");
  const hole = await asset(null, null);
  assert.equal((await post({ ids: [hole], mode: "name", device: real })).status, 400);
  const ok = await post({ session_id: sessionId, mode: "none" });
  assert.equal(ok.status, 200);
  assert.equal((await read(hole)).device_source, "none");
});

test("a name and 'not a camera' survive a re-index, and yield to a file that names a body", { skip: skipWithoutDb }, async () => {
  const { default: sharp } = await import("sharp");
  const { exiftool } = await import("exiftool-vendored");
  const { indexRoot } = await import("./indexer");
  const dir = await mkdtemp(path.join(os.tmpdir(), "winnow-named-"));
  const root = (await db.one<{ id: number }>(
    "INSERT INTO roots (path, kind, watch) VALUES ($1, 'source', false) RETURNING id",
    [dir],
  ))!.id;
  await db.q(
    "INSERT INTO sessions (root_id, name, source_path, ignored) VALUES ($1, 'x', $2, true)",
    [root, dir],
  );
  try {
    // Distinct bytes, or the indexer folds the second file as a duplicate.
    const make = async (name: string, colour: string) => {
      const file = path.join(dir, name);
      await sharp({ create: { width: 8, height: 8, channels: 3, background: colour } }).jpeg().toFile(file);
      return file;
    };
    const friend = await make("friend.jpg", "#123");
    const shot = await make("shot.jpg", "#456");
    const touch = async (file: string) => {
      const t = new Date((await stat(file)).mtimeMs + 120_000);
      await utimes(file, t, t);
    };
    const row = async (file: string) =>
      (await db.one<{ id: number; device: string | null; device_source: string | null }>(
        "SELECT id, device, device_source FROM assets WHERE abs_path = $1",
        [file],
      ))!;

    await indexRoot(root);
    const name = uniq("Sony inconnu");
    await da.labelDevice({ ids: [(await row(friend)).id], name });
    await da.labelDevice({ ids: [(await row(shot)).id], name: null });

    // The files still name nothing: both answers hold.
    await touch(friend);
    await touch(shot);
    await indexRoot(root);
    assert.deepEqual([(await row(friend)).device, (await row(friend)).device_source], [name, "named"]);
    assert.deepEqual([(await row(shot)).device, (await row(shot)).device_source], [null, "none"]);

    // A file that comes to name its body wins, as it does over any hand-fill.
    await exiftool.write(friend, { Make: "SONY", Model: "ILCE-7M4" }, { writeArgs: ["-overwrite_original"] });
    await touch(friend);
    await indexRoot(root);
    assert.deepEqual([(await row(friend)).device, (await row(friend)).device_source], ["SONY ILCE-7M4", "exif"]);
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

test("the device_source filter reads a pre-0043 body as from the file", { skip: skipWithoutDb }, async () => {
  const { buildFilter } = await import("./filter");
  const legacy = await asset(null, null);
  await db.q("UPDATE assets SET device = 'NIKON D90', device_source = NULL WHERE id = $1", [legacy]);
  const gone = await asset(null, null);
  await da.labelDevice({ ids: [gone], name: null });
  const pick = async (sources: string[]) => {
    const { conditions, params } = buildFilter({ device_source: sources, session_id: sessionId }, 1);
    return (await db.many<{ id: number }>(
      `SELECT a.id FROM assets a WHERE ${conditions.join(" AND ")} ORDER BY a.id`,
      params,
    )).map((r) => r.id);
  };
  assert.ok((await pick(["exif"])).includes(legacy));
  assert.deepEqual(await pick(["none"]), [gone]);
});
