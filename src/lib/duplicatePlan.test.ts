// The cleanup plan of the deduplication page: every group lands on the card of
// the rule branch that picks its survivor (or "manual"), a card's run touches
// only its own groups, and a run reports why it left a group behind instead of
// counting it. Database-backed: runs only with WINNOW_TEST_DATABASE_URL.
//
// Every query carries `q: base` — the listing reads the whole duplicate_hits
// table, and other test files write to it in parallel.
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { skipWithoutDb, useTestDatabase } from "../test/db";

const base = await mkdtemp(path.join(os.tmpdir(), "winnow-dedup-plan-"));
const library = path.join(base, "library");
const incoming = path.join(base, "incoming");
const finals = path.join(base, "finals");
useTestDatabase({ INCOMING_DIR: base, BROWSE_ROOTS: base });

let list: typeof import("./duplicateList");
let db: typeof import("./db");
let sessionId: number;

before(async () => {
  if (skipWithoutDb) return;
  list = await import("./duplicateList");
  db = await import("./db");
  const root = await db.one<{ id: number }>(
    "INSERT INTO roots (path, kind, watch) VALUES ($1, 'source', false) RETURNING id",
    [library],
  );
  // A Final volume: view-only, so its copy is the one a group keeps.
  await db.q("INSERT INTO roots (path, kind, watch) VALUES ($1, 'finals', false)", [finals]);
  const s = await db.one<{ id: number }>(
    "INSERT INTO sessions (root_id, name, source_path) VALUES ($1, 'plan', $2) RETURNING id",
    [root!.id, library],
  );
  sessionId = s!.id;
});

beforeEach(async () => {
  if (skipWithoutDb) return;
  await db.q("DELETE FROM duplicate_hits WHERE abs_path LIKE $1", [`${base}/%`]);
  await db.q("DELETE FROM assets WHERE session_id = $1", [sessionId]);
  for (const d of [library, incoming, finals]) {
    await rm(d, { recursive: true, force: true });
    await mkdir(d, { recursive: true });
  }
});

after(async () => {
  if (!skipWithoutDb) {
    await db.q("DELETE FROM duplicate_hits WHERE abs_path LIKE $1", [`${base}/%`]);
    await db.q("DELETE FROM assets WHERE session_id = $1", [sessionId]);
    await db.q("DELETE FROM sessions WHERE id = $1", [sessionId]);
    await db.q("DELETE FROM roots WHERE path = ANY($1::text[])", [[library, finals]]);
    await db.pool.end();
  }
  await rm(base, { recursive: true, force: true });
});

const exists = (p: string) => stat(p).then(() => true, () => false);
const HASH = () => `test-${randomBytes(8).toString("hex")}`;

async function asset(absPath: string, hash: string, bytes: Buffer): Promise<number> {
  await writeFile(absPath, bytes);
  const row = await db.one<{ id: number }>(
    `INSERT INTO assets (session_id, abs_path, rel_path, filename, ext, media_type, file_size, content_hash)
     VALUES ($1, $2, $3, $4, 'jpg', 'photo', $5, $6) RETURNING id`,
    [sessionId, absPath, path.basename(absPath), path.basename(absPath), bytes.length, hash],
  );
  return row!.id;
}

async function hit(absPath: string, hash: string, bytes: Buffer, verified: boolean | null, assetId: number | null) {
  await writeFile(absPath, bytes);
  await db.q(
    `INSERT INTO duplicate_hits (abs_path, content_hash, existing_asset_id, source, verified, file_size)
     VALUES ($1, $2, $3, 'index', $4, $5)`,
    [absPath, hash, assetId, verified, bytes.length],
  );
}

// One group per card, plus a library group the run will have to refuse: its
// recorded copy has the right size but other bytes, and was never verified.
async function seed() {
  const h = { prot: HASH(), lib: HASH(), refused: HASH(), manual: HASH() };
  const b = () => randomBytes(50_000);

  const master = b();
  const protId = await asset(path.join(finals, "M.jpg"), h.prot, master);
  await hit(path.join(incoming, "M.jpg"), h.prot, master, true, protId);

  const kept = b();
  const libId = await asset(path.join(library, "L.jpg"), h.lib, kept);
  await hit(path.join(incoming, "L.jpg"), h.lib, kept, true, libId);

  const refId = await asset(path.join(library, "R.jpg"), h.refused, b());
  await hit(path.join(incoming, "R.jpg"), h.refused, b(), null, refId);

  const loose = b();
  await mkdir(path.join(incoming, "copy"), { recursive: true });
  await hit(path.join(incoming, "U.jpg"), h.manual, loose, true, null);
  await hit(path.join(incoming, "copy", "U.jpg"), h.manual, loose, true, null);
  return h;
}

test("each group lands on the card of the branch that picks its survivor", { skip: skipWithoutDb }, async () => {
  const h = await seed();
  const all = await list.listDuplicateGroups({ q: base });

  assert.deepEqual(
    Object.fromEntries(Object.entries(all.plan).map(([k, f]) => [k, f.groups])),
    { protected: 1, library: 2, manual: 1 },
  );
  const byHash = new Map(all.groups.map((g) => [g.hash, g]));
  assert.equal(byHash.get(h.prot)!.auto_rule, "protected");
  assert.equal(byHash.get(h.prot)!.auto_keep, path.join(finals, "M.jpg"));
  assert.equal(byHash.get(h.lib)!.auto_rule, "library");
  assert.equal(byHash.get(h.manual)!.auto_rule, null);

  // Filtering on a card narrows the list, never the plan.
  const manual = await list.listDuplicateGroups({ q: base, rule: "manual" });
  assert.deepEqual(manual.groups.map((g) => g.hash), [h.manual]);
  assert.equal(manual.plan.library.groups, 2);
  assert.equal(manual.facets.all.groups, 1);
});

test("a card's run touches its own groups and says why it left one behind", { skip: skipWithoutDb }, async () => {
  const h = await seed();
  const r = await list.resolveDuplicatesAuto({ q: base, rule: "library" });

  assert.equal(r.resolved, 2);
  assert.equal(r.deleted, 1);
  assert.equal(await exists(path.join(incoming, "L.jpg")), false);
  // The refused copy stays, with its reason counted rather than lost.
  assert.equal(await exists(path.join(incoming, "R.jpg")), true);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].count, 1);
  assert.match(r.skipped[0].reason, /not deleted/);
  assert.deepEqual(r.retry, [h.refused]);
  assert.equal(r.remaining, 0, "the refused group is not counted as still to do");
  // The other card's group was not part of the run.
  assert.equal(await exists(path.join(incoming, "M.jpg")), true);

  // Handed back as `exclude`, the refused group is not picked again.
  const again = await list.resolveDuplicatesAuto({ q: base, rule: "library", exclude: r.retry });
  assert.equal(again.resolved, 0);

  // "manual" selects nothing to resolve, by definition.
  const none = await list.resolveDuplicatesAuto({ q: base, rule: "manual" });
  assert.equal(none.resolved, 0);
});
