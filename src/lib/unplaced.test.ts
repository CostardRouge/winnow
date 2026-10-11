// lib/unplaced.ts against a real database: a folder shot in two towns is cut
// into one card per town, each with its own suggestion — the regression was
// one card, one suggestion (the dominant cell's median), and the second
// town's frames placed in the first. And the Place dialog's "already used near
// these dates" list. Database-backed: runs only with WINNOW_TEST_DATABASE_URL
// (a migrated scratch database). Invented fixtures, dated 1999 so the
// library-wide read cannot meet another test file's rows.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { skipWithoutDb, useTestDatabase } from "../test/db";

useTestDatabase();

let up: typeof import("./unplaced");
let db: typeof import("./db");
let rootId: number;
let camId: number;
let seq = 0;

const MPL = { lat: 43.6108, lon: 3.8767 };
const SETE = { lat: 43.4028, lon: 3.6928 };
const PEROLS = { lat: 43.5653, lon: 3.9536 };

async function session(name: string, from: string, to: string): Promise<number> {
  const s = await db.one<{ id: number }>(
    `INSERT INTO sessions (root_id, name, source_path, captured_at_min, captured_at_max)
     VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz) RETURNING id`,
    [rootId, name, `/unplaced-test/${name}`, from, to],
  );
  return s!.id;
}

async function media(
  sid: number,
  at: string,
  o: { gps?: { lat: number; lon: number }; source?: "manual" | "inferred"; model?: string } = {},
): Promise<void> {
  seq++;
  await db.q(
    `INSERT INTO assets (session_id, abs_path, rel_path, filename, ext, media_type,
                         captured_at, gps, gps_source, camera_model)
     VALUES ($1, $2, $3, $3, 'arw', 'photo', $4::timestamptz, $5::jsonb, $6, $7)`,
    [
      sid,
      `/unplaced-test/F${seq}.arw`,
      `F${seq}.arw`,
      at,
      o.gps ? JSON.stringify(o.gps) : null,
      o.source ?? null,
      o.model ?? "ILCE-7CM2",
    ],
  );
}

const at = (h: number, m = 0) =>
  `1999-06-01T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`;

before(async () => {
  if (skipWithoutDb) return;
  up = await import("./unplaced");
  db = await import("./db");
  const root = await db.one<{ id: number }>(
    "INSERT INTO roots (path, kind, watch) VALUES ('/unplaced-test', 'source', false) RETURNING id",
  );
  rootId = root!.id;

  // The Sony folder: Montpellier 10:00–12:00, a drive, Sète 13:30–15:00.
  camId = await session("two towns", at(10), at(15));
  for (let m = 10 * 60; m <= 12 * 60; m += 10) await media(camId, at(Math.floor(m / 60), m % 60));
  for (let m = 13 * 60 + 30; m <= 15 * 60; m += 10) await media(camId, at(Math.floor(m / 60), m % 60));

  // The phone in the pocket, located, in another folder with nothing to place.
  const phone = await session("phone", at(10, 15), at(14, 50));
  for (const [h, m] of [[10, 15], [10, 45], [11, 30]])
    await media(phone, at(h, m), { gps: MPL, model: "iPhone 15 Pro Max" });
  for (const [h, m] of [[13, 45], [14, 15], [14, 50]])
    await media(phone, at(h, m), { gps: SETE, model: "iPhone 15 Pro Max" });

  // A folder the maintainer placed two days earlier, by accepting a suggestion.
  const earlier = await session("earlier", "1999-05-30T09:00:00Z", "1999-05-30T10:00:00Z");
  for (let i = 0; i < 3; i++)
    await media(earlier, `1999-05-30T09:0${i}:00Z`, { gps: PEROLS, source: "inferred" });
});

after(async () => {
  if (skipWithoutDb) return;
  await db.q(
    "DELETE FROM assets WHERE session_id IN (SELECT id FROM sessions WHERE root_id = $1)",
    [rootId],
  );
  await db.q("DELETE FROM sessions WHERE root_id = $1", [rootId]);
  await db.q("DELETE FROM roots WHERE id = $1", [rootId]);
  await db.pool.end();
});

test("a folder shot in two towns becomes one card per town", { skip: skipWithoutDb }, async () => {
  const r = await up.listUnplaced();
  const cards = r.groups
    .filter((g) => g.sessions[0].id === camId)
    .sort((a, b) => Date.parse(a.t0) - Date.parse(b.t0));
  assert.equal(cards.length, 2, JSON.stringify(cards.map((c) => c.key)));
  const [mpl, sete] = cards;
  assert.equal(mpl.kind, "part");
  assert.deepEqual(mpl.place, { index: 1, count: 2 });
  assert.deepEqual(sete.place, { index: 2, count: 2 });
  assert.deepEqual(mpl.siblings, []);
  // 13 frames in Montpellier (10:00…12:00), 10 in Sète (13:30…15:00).
  assert.equal(mpl.unplaced, 13);
  assert.equal(sete.unplaced, 10);
  // Cut in the drive, nowhere else.
  assert.ok(Date.parse(mpl.t1) < Date.parse(at(13, 30)));
  assert.ok(Date.parse(sete.t0) > Date.parse(at(12)));
  assert.ok(Date.parse(mpl.t1) <= Date.parse(sete.t0));
  // Each its own suggestion, in its own town.
  assert.ok(Math.abs(mpl.suggestion!.lat - MPL.lat) < 1e-6);
  assert.ok(Math.abs(sete.suggestion!.lat - SETE.lat) < 1e-6);
  assert.equal(mpl.suggestion!.located, 3);
  assert.equal(mpl.suggestion!.window, "near");
});

test("the places already used near a card, nearest first", { skip: skipWithoutDb }, async () => {
  const places = await up.placesNear(at(10), at(15));
  const perols = places.find(
    (p) => Math.abs(p.lat - PEROLS.lat) < 1e-3 && Math.abs(p.lon - PEROLS.lon) < 1e-3,
  );
  assert.ok(perols, JSON.stringify(places));
  assert.equal(perols.count, 3);
  assert.equal(perols.verified, false);
  // Last placed frame 09:02 on the 30th, the card opens 10:00 on the 1st.
  assert.ok(perols.gap_h < -48 && perols.gap_h > -49, String(perols.gap_h));
  // Camera fixes are not "places already used": only human placements are.
  assert.ok(!places.some((p) => Math.abs(p.lat - MPL.lat) < 1e-3));
});
