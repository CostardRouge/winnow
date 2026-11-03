// An uploaded edit that names its source capture (`original_asset_id` on POST
// /api/upload — what Atelier's "send to Winnow" sends) is linked to it by the
// import itself, with no admin reconcile (cf. lib/importLinks.ts, migration
// 0057):
//   - the field's shapes (one value for the request, or one per file);
//   - a new file: the import records the link, the indexer applies it when it
//     inserts the row — the real runImport → indexRoot chain;
//   - a confirmed duplicate of a file already in the library: linked at once;
//   - an id naming no asset, or one in the trash: ignored with its reason, the
//     file still imported;
//   - an existing link is never overwritten.
// Database-backed except the first: runs only with WINNOW_TEST_DATABASE_URL.
// The incoming folder is indexed in an IGNORED session and the import's index
// enqueue goes through its hook, so no Redis is needed.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { skipWithoutDb, useTestDatabase } from "../test/db";
import { parseOriginalIds } from "./uploadLinkField";

const base = await mkdtemp(path.join(os.tmpdir(), "winnow-import-links-"));
const inbox = path.join(base, "inbox");
const incoming = path.join(base, "incoming");
const library = path.join(base, "library");
useTestDatabase({ INBOX_DIR: inbox, INCOMING_DIR: incoming, GEOCODE_ENABLED: "false" });

let db: typeof import("./db");
let imp: typeof import("./import");
let links: typeof import("./importLinks");
let sessionId: number;

before(async () => {
  if (skipWithoutDb) return;
  db = await import("./db");
  imp = await import("./import");
  links = await import("./importLinks");
  const root = await db.one<{ id: number }>(
    "INSERT INTO roots (path, kind, watch) VALUES ($1, 'source', false) RETURNING id",
    [library],
  );
  sessionId = (await db.one<{ id: number }>(
    "INSERT INTO sessions (root_id, name, source_path) VALUES ($1, 's', $2) RETURNING id",
    [root!.id, path.join(library, "s")],
  ))!.id;
  await mkdir(path.join(library, "s"), { recursive: true });
});

after(async () => {
  if (!skipWithoutDb) {
    await db.q("DELETE FROM import_links WHERE abs_path LIKE $1", [`${base}/%`]);
    await db.q("DELETE FROM duplicate_hits WHERE abs_path LIKE $1", [`${base}/%`]);
    // Edits first: original_asset_id points across the two roots.
    await db.q("UPDATE assets SET original_asset_id = NULL WHERE abs_path LIKE $1", [`${base}/%`]);
    await db.q("DELETE FROM roots WHERE path = ANY($1)", [[library, incoming]]); // cascades
    const { closeExiftool } = await import("./extract");
    await closeExiftool();
    await db.pool.end();
  }
  await rm(base, { recursive: true, force: true });
});

let seq = 0;
/** A capture already in the library (no file needed: nothing reads it). */
async function capture(opts: { trashed?: boolean } = {}): Promise<number> {
  seq++;
  const abs = path.join(library, "s", `DSC0${seq}.ARW`);
  return (await db.one<{ id: number }>(
    `INSERT INTO assets (session_id, abs_path, rel_path, filename, ext, media_type, deleted_at)
     VALUES ($1, $2, $3, $3, 'arw', 'photo', CASE WHEN $4 THEN now() END) RETURNING id`,
    [sessionId, abs, path.basename(abs), !!opts.trashed],
  ))!.id;
}

/** A real, unique JPEG (random pixels: no two fixtures share a hash). */
async function jpeg(): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  return sharp(randomBytes(16 * 16 * 3), { raw: { width: 16, height: 16, channels: 3 } })
    .jpeg()
    .toBuffer();
}

/** Stages one upload the way POST /api/upload does, and imports it. */
async function upload(name: string, bytes: Buffer, originalId: number) {
  const dir = path.join(inbox, ".uploads", `upload-${randomBytes(4).toString("hex")}`);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), bytes);
  const enqueued: number[] = [];
  const res = await imp.runImport(
    { sourceDir: dir, origin: "web_upload", removeAfter: true, links: { [name]: originalId } },
    { enqueueIndex: async (rootId) => void enqueued.push(rootId) },
  );
  return { res, enqueued };
}

/** Where the import filed `name` under the incoming. */
async function filed(name: string): Promise<string> {
  const all = (await readdir(incoming, { recursive: true })) as string[];
  const hit = all.find((p) => path.basename(p) === name);
  assert.ok(hit, `${name} filed under the incoming`);
  return path.join(incoming, hit);
}

const linkOf = async (where: { id?: number; abs?: string }) =>
  (await db.one<{ original_asset_id: number | null; edit_match: string | null }>(
    `SELECT original_asset_id, edit_match FROM assets WHERE ${where.id != null ? "id" : "abs_path"} = $1`,
    [where.id ?? where.abs],
  ))!;

test("original_asset_id: one value for the request, or one per file", () => {
  assert.deepEqual(parseOriginalIds([], 2), { ok: true, ids: [null, null], invalid: [null, null] });
  assert.deepEqual(parseOriginalIds(["42"], 2), { ok: true, ids: [42, 42], invalid: [null, null] });
  assert.deepEqual(parseOriginalIds([" 7 ", ""], 2), { ok: true, ids: [7, null], invalid: [null, null] });
  assert.deepEqual(parseOriginalIds(["abc"], 1), {
    ok: true,
    ids: [null],
    invalid: [{ value: "abc", reason: "not an asset id" }],
  });
  for (const v of ["0", "-3", "1.5", "99999999999999999999"]) {
    const r = parseOriginalIds([v], 1);
    assert.ok(r.ok, v);
    assert.deepEqual([r.ids[0], r.invalid[0]?.reason], [null, "not an asset id"], v);
  }
  const bad = parseOriginalIds(["1", "2"], 3);
  assert.equal(bad.ok, false, "two values for three files is not guessed");
});

test("a new upload is linked to its source when the indexer inserts it", { skip: skipWithoutDb }, async () => {
  const source = await capture();
  const { res, enqueued } = await upload("EDIT_0001.jpg", await jpeg(), source);
  assert.equal(res.imported, 1);
  assert.equal(res.links.recorded, 1);
  assert.deepEqual(res.links.ignored, []);
  assert.equal(enqueued.length, 1, "the incoming is indexed next");

  const abs = await filed("EDIT_0001.jpg");
  // Index that folder for real, as the enqueued job would, in an ignored
  // session: same INSERT and end-of-scan passes, no derivative to enqueue.
  await db.q(
    `INSERT INTO sessions (root_id, name, source_path, ignored) VALUES ($1, 'up', $2, true)
     ON CONFLICT (source_path) DO UPDATE SET ignored = true`,
    [enqueued[0], path.dirname(abs)],
  );
  const { indexRoot } = await import("./indexer");
  const scan = await indexRoot(enqueued[0]);
  assert.ok(scan.inserted >= 1);

  assert.deepEqual(await linkOf({ abs }), { original_asset_id: source, edit_match: "upload" });
  const left = await db.one("SELECT 1 FROM import_links WHERE abs_path = $1", [abs]);
  assert.equal(left, null, "the pending row is settled");
});

test("an upload identical to a file already in the library links that file", { skip: skipWithoutDb }, async () => {
  const source = await capture();
  const bytes = await jpeg();
  const twin = path.join(library, "s", "EDIT_0002.jpg");
  await writeFile(twin, bytes);
  const { partialHash } = await import("./hash");
  const twinId = (await db.one<{ id: number }>(
    `INSERT INTO assets (session_id, abs_path, rel_path, filename, ext, media_type, file_size, content_hash)
     VALUES ($1, $2, 'EDIT_0002.jpg', 'EDIT_0002.jpg', 'jpg', 'photo', $3, $4) RETURNING id`,
    [sessionId, twin, bytes.length, await partialHash(twin, bytes.length)],
  ))!.id;

  const { res } = await upload("EDIT_0002.jpg", bytes, source);
  assert.equal(res.duplicates, 1);
  assert.equal(res.links.linked, 1);
  assert.deepEqual(await linkOf({ id: twinId }), { original_asset_id: source, edit_match: "upload" });

  // Sent again: already this link — nothing to do, nothing reported.
  const again = await upload("EDIT_0002.jpg", bytes, source);
  assert.deepEqual(again.res.links.ignored, []);
});

test("an id naming no asset, or a trashed one, is ignored with its reason; the file still imports", { skip: skipWithoutDb }, async () => {
  const missing = 2 ** 40;
  assert.equal(await links.linkTargetProblem(missing), `asset ${missing} does not exist`);
  const trashed = await capture({ trashed: true });
  assert.equal(await links.linkTargetProblem(trashed), `asset ${trashed} is in the trash`);

  for (const [name, id] of [["EDIT_0003.jpg", missing], ["EDIT_0004.jpg", trashed]] as const) {
    const { res } = await upload(name, await jpeg(), id);
    assert.equal(res.imported, 1, "the bytes are imported all the same");
    assert.equal(res.links.recorded, 0);
    assert.equal(res.links.ignored.length, 1);
    assert.match(res.links.ignored[0].reason, id === missing ? /does not exist/ : /in the trash/);
    const abs = await filed(name);
    assert.equal(await db.one("SELECT 1 FROM import_links WHERE abs_path = $1", [abs]), null);
  }
});

test("a link already written is never overwritten", { skip: skipWithoutDb }, async () => {
  const first = await capture();
  const second = await capture();
  const edit = (await db.one<{ id: number }>(
    `INSERT INTO assets (session_id, abs_path, rel_path, filename, ext, media_type,
                         original_asset_id, edit_match)
     VALUES ($1, $2, 'EDIT_0005.jpg', 'EDIT_0005.jpg', 'jpg', 'photo', $3, 'name_date') RETURNING id`,
    [sessionId, path.join(library, "s", "EDIT_0005.jpg"), first],
  ))!.id;
  await links.recordImportLink(path.join(library, "s", "EDIT_0005.jpg"), second);

  const out = await links.applyImportLinks({ paths: [path.join(library, "s", "EDIT_0005.jpg")] });
  assert.equal(out.linked, 0);
  assert.deepEqual(out.ignored.map((g) => g.reason), [`already linked to asset ${first}`]);
  assert.deepEqual(await linkOf({ id: edit }), { original_asset_id: first, edit_match: "name_date" });
});
