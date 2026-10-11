// The clip probe against a real database (lib/deviceProbe.ts, migration 0049):
//   - what a clip's track names takes the place EXIF takes in the indexer
//     guard: it fills a hole, replaces a vote or a hand-fill, never a human
//     override and never a body the file's EXIF declares;
//   - a track that no longer names a body withdraws the one a probe wrote;
//   - the pass reads only unread clips, stamps what it read, and leaves an
//     unreadable file unstamped for the next pass;
//   - the indexer probes a new clip whose EXIF names no body;
//   - revert goes back to the track's body when the file's EXIF names none.
// Database-backed: runs only with WINNOW_TEST_DATABASE_URL. Clips are
// synthetic (src/test/djiClip.ts) in a temp directory; the indexer test uses
// an IGNORED session so nothing is enqueued and no Redis is needed.
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { skipWithoutDb, useTestDatabase } from "../test/db";
import { djiClip, miniHeader } from "../test/djiClip";

useTestDatabase({ GEOCODE_ENABLED: "false" });

let db: typeof import("./db");
let probe: typeof import("./deviceProbe");
let da: typeof import("./deviceAttribution");
let dir: string;
let rootId: number;
let sessionId: number;
let seq = 0;

before(async () => {
  if (skipWithoutDb) return;
  db = await import("./db");
  probe = await import("./deviceProbe");
  da = await import("./deviceAttribution");
  dir = await mkdtemp(path.join(os.tmpdir(), "winnow-probe-"));
  rootId = (await db.one<{ id: number }>(
    "INSERT INTO roots (path, kind, watch) VALUES ($1, 'source', false) RETURNING id",
    [dir],
  ))!.id;
  // IGNORED: the indexer test then enqueues no derivative.
  sessionId = (await db.one<{ id: number }>(
    "INSERT INTO sessions (root_id, name, source_path, ignored) VALUES ($1, 'p', $2, true) RETURNING id",
    [rootId, dir],
  ))!.id;
});

beforeEach(async () => {
  if (skipWithoutDb) return;
  await db.q("DELETE FROM assets WHERE session_id = $1", [sessionId]);
});

after(async () => {
  if (skipWithoutDb) return;
  await db.q("DELETE FROM assets WHERE session_id = $1", [sessionId]);
  await db.q("DELETE FROM sessions WHERE root_id = $1", [rootId]);
  await db.q("DELETE FROM roots WHERE id = $1", [rootId]);
  await rm(dir, { recursive: true, force: true });
  const { closeExiftool } = await import("./extract");
  await closeExiftool();
  await db.pool.end();
});

/** A video row pointing at a file in `dir`, written or not. */
async function clip(
  opts: {
    device?: string | null;
    source?: string | null;
    exif?: string | null;
    file?: Buffer | null;
  } = {},
): Promise<{ id: number; path: string }> {
  seq++;
  const p = path.join(dir, `DJI_${String(seq).padStart(4, "0")}_D.MP4`);
  if (opts.file !== null) await writeFile(p, opts.file ?? djiClip());
  const id = (await db.one<{ id: number }>(
    `INSERT INTO assets (session_id, abs_path, rel_path, filename, ext, media_type,
                         captured_at, device, camera_model, device_source, device_exif)
     VALUES ($1, $2, $3, $3, 'mp4', 'video', now(), $4,
             CASE WHEN $4::text IS NOT NULL THEN split_part($4, ' ', 2) END, $5, $6)
     RETURNING id`,
    [sessionId, p, path.basename(p), opts.device ?? null, opts.source ?? null, opts.exif ?? null],
  ))!.id;
  return { id, path: p };
}

const row = async (id: number) =>
  (await db.one<{
    device: string | null;
    camera_model: string | null;
    device_source: string | null;
    embedded_device: string | null;
    embedded_serial: string | null;
    probed: boolean;
  }>(
    `SELECT device, camera_model, device_source, embedded_device, embedded_serial,
            embedded_probed_at IS NOT NULL AS probed
       FROM assets WHERE id = $1`,
    [id],
  ))!;

const read = (p: string) => import("./djiTrack").then((m) => m.probeDjiTrack(p));

test("the track fills a hole and replaces a guess, never a human correction", { skip: skipWithoutDb }, async () => {
  const hole = await clip();
  const voted = await clip({ device: "DJI FC8482", source: "derived" });
  const wrong = await clip({ device: "SONY ILCE-7CM2", source: "manual" });
  const fixed = await clip({ device: "SONY ILCE-6700", source: "override" });

  assert.equal((await probe.applyProbe(hole.id, await read(hole.path)))?.outcome, "filled");
  assert.equal((await probe.applyProbe(voted.id, await read(voted.path)))?.outcome, "confirmed");
  assert.equal((await probe.applyProbe(wrong.id, await read(wrong.path)))?.outcome, "corrected");
  assert.equal((await probe.applyProbe(fixed.id, await read(fixed.path)))?.outcome, "overridden");

  for (const c of [hole, voted, wrong])
    assert.deepEqual(
      { ...(await row(c.id)) },
      {
        device: "DJI FC8482",
        camera_model: "FC8482",
        device_source: "embedded",
        embedded_device: "DJI FC8482",
        embedded_serial: "1581F6Z9725AW003R0EN",
        probed: true,
      },
    );
  const kept = await row(fixed.id);
  assert.equal(kept.device, "SONY ILCE-6700");
  assert.equal(kept.device_source, "override");
  // Recorded beside it, for the viewer and for revert.
  assert.equal(kept.embedded_device, "DJI FC8482");
});

test("a track that stops naming a body withdraws the one a probe wrote", { skip: skipWithoutDb }, async () => {
  const c = await clip();
  await probe.applyProbe(c.id, await read(c.path));
  // The file was re-encoded: no DJI track any more.
  await writeFile(c.path, djiClip({ header: null }));
  assert.equal((await probe.applyProbe(c.id, await read(c.path)))?.outcome, "no-track");
  const r = await row(c.id);
  assert.deepEqual([r.device, r.device_source, r.embedded_device, r.probed], [null, null, null, true]);
  // A hand-fill is not the probe's to withdraw.
  const m = await clip({ device: "DJI FC8482", source: "manual", file: djiClip({ header: null }) });
  await probe.applyProbe(m.id, await read(m.path));
  assert.equal((await row(m.id)).device_source, "manual");
});

test("the pass reads only unread clips and leaves an unreadable one for later", { skip: skipWithoutDb }, async () => {
  const a = await clip();
  const b = await clip({ file: djiClip({ header: miniHeader({ camera: null, model: "DJI Neo" }) }) });
  const phone = await clip({ file: djiClip({ header: null }) });
  const gone = await clip({ file: null });
  // A clip whose EXIF names a body is not in the backlog at all.
  const sony = await clip({ device: "SONY ILCE-7CM2", source: "exif", exif: "SONY ILCE-7CM2" });

  // Scoped to this test's folder: the pass is library-wide, and other test
  // files share the database (and run beside this one).
  assert.equal(await probe.countUnprobed(sessionId), 4);
  const r = await probe.runDeviceProbe({ sessionId });
  assert.deepEqual(
    {
      probed: r.probed, filled: r.filled, untold: r.untold, noTrack: r.noTrack,
      unreadable: r.unreadable, remaining: r.remaining, cameras: r.cameras,
    },
    {
      probed: 3, filled: 1, untold: 1, noTrack: 1,
      unreadable: 1, remaining: 1, cameras: { "DJI FC8482": 1 },
    },
  );
  assert.equal((await row(a.id)).device, "DJI FC8482");
  assert.equal((await row(b.id)).device, null);
  assert.equal((await row(phone.id)).probed, true);
  assert.equal((await row(gone.id)).probed, false);
  assert.equal((await row(sony.id)).probed, false);
  // Nothing new to read: a second pass reads only the unreadable one again.
  assert.equal((await probe.runDeviceProbe({ sessionId })).unreadable, 1);
});

test("the indexer reads a new clip's track when its EXIF names no body", { skip: skipWithoutDb }, async () => {
  const { indexRoot } = await import("./indexer");
  const p = path.join(dir, "DJI_20261010_0001_D.MP4");
  // Its own serial: the other tests leave byte-identical clips in this folder,
  // and the indexer would drop this one as their duplicate.
  await writeFile(p, djiClip({ header: miniHeader({ serial: "1581F6ZINDEXTEST01" }) }));
  await indexRoot(rootId);
  const r = await db.one<{ device: string | null; device_source: string | null; embedded_serial: string | null }>(
    "SELECT device, device_source, embedded_serial FROM assets WHERE abs_path = $1",
    [p],
  );
  assert.deepEqual(
    [r?.device, r?.device_source, r?.embedded_serial],
    ["DJI FC8482", "embedded", "1581F6ZINDEXTEST01"],
  );
});

test("revert goes back to the track's body when the EXIF names none", { skip: skipWithoutDb }, async () => {
  const c = await clip();
  await probe.applyProbe(c.id, await read(c.path));
  await da.overrideDevice({ ids: [c.id], device: "SONY ILCE-6700", cameraModel: "ILCE-6700" });
  assert.deepEqual(await da.revertDevice([c.id]), { updated: 1, skipped: 0 });
  const r = await row(c.id);
  assert.deepEqual([r.device, r.camera_model, r.device_source], ["DJI FC8482", "FC8482", "embedded"]);
  // Already what its file says: nothing to revert.
  assert.deepEqual(await da.revertDevice([c.id]), { updated: 0, skipped: 1 });
});
