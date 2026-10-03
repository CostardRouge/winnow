// BE-01 (docs/CODEBASE-AUDIT.md): an import used to treat "could not verify
// against the existing copy" exactly like "confirmed duplicate", and deleted the
// source. The typical trigger is a library row that still holds the file's
// content_hash but whose bytes are gone (purged, moved, removed by hand).
// Database-backed: runs only with WINNOW_TEST_DATABASE_URL (src/test/db.ts).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { skipWithoutDb, useTestDatabase } from "../test/db";

const base = await mkdtemp(path.join(os.tmpdir(), "winnow-import-test-"));
const inbox = path.join(base, "inbox");
const library = path.join(base, "library");
useTestDatabase({ INBOX_DIR: inbox, INCOMING_DIR: path.join(base, "incoming") });

type Mods = {
  runImport: typeof import("./import").runImport;
  quarantineDir: string;
  partialHash: typeof import("./hash").partialHash;
  db: typeof import("./db");
};
let m: Mods;
let sessionId: number;

before(async () => {
  if (skipWithoutDb) return;
  const imp = await import("./import");
  m = {
    runImport: imp.runImport,
    quarantineDir: imp.quarantineDir,
    partialHash: (await import("./hash")).partialHash,
    db: await import("./db"),
  };
  const root = await m.db.one<{ id: number }>(
    "INSERT INTO roots (path, kind, watch) VALUES ($1, 'source', false) RETURNING id",
    [library],
  );
  const session = await m.db.one<{ id: number }>(
    "INSERT INTO sessions (root_id, name, source_path) VALUES ($1, 'test', $2) RETURNING id",
    [root!.id, path.join(library, "s")],
  );
  sessionId = session!.id;
  await mkdir(path.join(library, "s"), { recursive: true });
});

after(async () => {
  if (!skipWithoutDb) {
    await m.db.q("DELETE FROM duplicate_hits WHERE abs_path LIKE $1", [`${base}/%`]);
    await m.db.q("DELETE FROM roots WHERE path = $1", [library]); // cascades
    await m.db.pool.end();
  }
  await rm(base, { recursive: true, force: true });
});

// A library row holding `bytes`' partial hash, at `absPath` (which may not exist).
async function libraryRow(absPath: string, bytes: Buffer, purged: boolean) {
  const tmp = path.join(base, `hash-${randomBytes(4).toString("hex")}`);
  await writeFile(tmp, bytes);
  const hash = await m.partialHash(tmp, bytes.length);
  await rm(tmp);
  await m.db.q(
    `INSERT INTO assets (session_id, abs_path, rel_path, filename, ext, media_type,
                         file_size, content_hash, deleted_at, purged_at)
     VALUES ($1, $2, $3, $4, 'jpg', 'photo', $5, $6, $7, $7)`,
    [sessionId, absPath, path.relative(library, absPath), path.basename(absPath),
     bytes.length, hash, purged ? new Date().toISOString() : null],
  );
}

async function drop(name: string, bytes: Buffer): Promise<{ dir: string; file: string }> {
  const dir = path.join(inbox, `drop-${randomBytes(4).toString("hex")}`);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await writeFile(file, bytes);
  return { dir, file };
}

const exists = (p: string) => stat(p).then(() => true, () => false);

test("a source whose library twin cannot be read is kept, never deleted", { skip: skipWithoutDb }, async () => {
  const bytes = randomBytes(200_000);
  // The library row still holds the hash, but its file is gone (a purge).
  await libraryRow(path.join(library, "s", "DSC0001.jpg"), bytes, true);
  const { dir, file } = await drop("DSC0001.jpg", bytes);

  const res = await m.runImport({ sourceDir: dir, origin: "inbox", removeAfter: true });

  assert.equal(res.duplicates, 0, "an unverifiable match is not a duplicate");
  assert.equal(res.failed, 1);
  assert.match(res.errors[0].error, /could not be read/);
  assert.equal(await exists(file), false, "moved out of the inbox…");
  const kept = path.join(m.quarantineDir, "DSC0001.jpg");
  assert.deepEqual(await readFile(kept), bytes, "…into quarantine, bytes intact");
});

test("a confirmed duplicate is still dropped (and deleted when removeAfter)", { skip: skipWithoutDb }, async () => {
  const bytes = randomBytes(200_000);
  const twin = path.join(library, "s", "DSC0002.jpg");
  await writeFile(twin, bytes);
  await libraryRow(twin, bytes, false);
  const { dir, file } = await drop("DSC0002.jpg", bytes);

  const res = await m.runImport({ sourceDir: dir, origin: "inbox", removeAfter: true });

  assert.equal(res.duplicates, 1);
  assert.equal(res.failed, 0);
  assert.equal(await exists(file), false);
  assert.deepEqual(
    (await readdir(m.quarantineDir).catch(() => [] as string[])).filter((n) => n.startsWith("DSC0002")),
    [],
    "nothing quarantined",
  );
});
