// Whose camera is it (lib/gearOwners.ts, migration 0053), against a real
// database:
//   - the four answers are stored and read back on /gear's own payload;
//   - fields that do not apply to an answer are dropped, a span that ends
//     before it starts and an unknown body are refused;
//   - a person's current name wins, and deleting the person keeps the name;
//   - "Shot by" puts every medium in exactly one bucket, the span included
//     (inside: me; outside: others), and a body with no row is "unsorted";
//   - the route checks its shape.
// Database-backed: runs only with WINNOW_TEST_DATABASE_URL. Bodies get names of
// this run only — other test files share the database and the gear dimension
// is library-wide.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { skipWithoutDb, useTestDatabase } from "../test/db";

useTestDatabase();

let db: typeof import("./db");
let go: typeof import("./gearOwners");
let rootId: number;
let sessionId: number;
let seq = 0;
const run = `${process.pid}-${Date.now()}`;
const body = (label: string) => `${label} ${run}`;

before(async () => {
  if (skipWithoutDb) return;
  db = await import("./db");
  go = await import("./gearOwners");
  // The shelf only counts source/inbox/finals roots, like lib/gear.ts.
  rootId = (await db.one<{ id: number }>(
    "INSERT INTO roots (path, kind, watch) VALUES ($1, 'source', false) RETURNING id",
    [`/gear-owner-test-${run}`],
  ))!.id;
  sessionId = (await db.one<{ id: number }>(
    "INSERT INTO sessions (root_id, name, source_path) VALUES ($1, 'g', $2) RETURNING id",
    [rootId, `/gear-owner-test-${run}/g`],
  ))!.id;
});

after(async () => {
  if (skipWithoutDb) return;
  await db.q("DELETE FROM gear_owners WHERE device LIKE $1", [`% ${run}`]);
  await db.q("DELETE FROM assets WHERE session_id = $1", [sessionId]);
  await db.q("DELETE FROM sessions WHERE id = $1", [sessionId]);
  await db.q("DELETE FROM roots WHERE id = $1", [rootId]);
  await db.q("DELETE FROM people WHERE name LIKE $1", [`% ${run}`]);
  await db.pool.end();
});

/** A medium shot with `device` on `day` (YYYY-MM-DD), optionally named by hand. */
async function shot(device: string | null, day: string | null, named = false): Promise<number> {
  seq++;
  return (await db.one<{ id: number }>(
    `INSERT INTO assets (session_id, abs_path, rel_path, filename, ext, media_type,
                         captured_at, device, device_source)
     VALUES ($1, $2, $3, $3, '.jpg', 'photo', $4::timestamptz, $5, $6)
     RETURNING id`,
    [
      sessionId,
      `/gear-owner-test-${run}/g/f${seq}.jpg`,
      `f${seq}.jpg`,
      day ? `${day}T12:00:00Z` : null,
      device,
      device ? (named ? "named" : "exif") : null,
    ],
  ))!.id;
}

/** The bucket "Shot by" puts each of these media in. */
async function shotBy(ids: number[]): Promise<string[]> {
  const { SHOT_BY_SQL } = await import("./filter");
  const rows = await db.many<{ id: number; b: string }>(
    `SELECT a.id, ${SHOT_BY_SQL} AS b FROM assets a WHERE a.id = ANY($1)`,
    [ids],
  );
  const by = new Map(rows.map((r) => [r.id, r.b]));
  return ids.map((id) => by.get(id)!);
}

test("the four answers, and the span that decides 'me' from 'others'", { skip: skipWithoutDb }, async () => {
  const phone = body("Apple iPhone 5s");
  const friend = body("FUJIFILM X-S20");
  const app = body("QQ Tencent");
  const loose = body("SONY DSC-HX200V");
  const before = await shot(phone, "2013-06-30");
  const during = await shot(phone, "2014-02-01");
  const firstDay = await shot(phone, "2013-07-01");
  const lastDay = await shot(phone, "2016-03-31");
  const after = await shot(phone, "2016-04-01");
  const f = await shot(friend, "2022-06-01");
  const qq = await shot(app, "2013-11-01", true);
  const l = await shot(loose, "2013-08-01");
  const nobody = await shot(null, "2020-01-01");

  await go.setOwner({ device: phone, owner: "mine", from: "2013-07-01", until: "2016-03-31" });
  await go.setOwner({ device: friend, owner: "other", name: "  Aymeric   B " });
  await go.setOwner({ device: app, owner: "none" });

  assert.deepEqual(
    await shotBy([before, firstDay, during, lastDay, after, f, qq, l, nobody]),
    ["others", "me", "me", "me", "others", "others", "none", "unsorted", "none"],
  );

  const owners = await go.listOwners();
  assert.deepEqual(owners.get(phone), {
    owner: "mine", person_id: null, owner_name: null,
    owned_from: "2013-07-01", owned_until: "2016-03-31",
  });
  assert.equal(owners.get(friend)?.owner_name, "Aymeric B");
  assert.equal(owners.has(loose), false);

  // An open span: mine since forever / still mine.
  await go.setOwner({ device: phone, owner: "mine" });
  assert.deepEqual(await shotBy([before, after]), ["me", "me"]);

  // Back to "not sorted": the row is gone, the media unsorted again.
  assert.equal(await go.setOwner({ device: phone, owner: null }), null);
  assert.deepEqual(await shotBy([during]), ["unsorted"]);
});

test("fields that do not apply are dropped, nonsense is refused", { skip: skipWithoutDb }, async () => {
  const cam = body("Canon EOS R");
  await shot(cam, "2025-05-01");
  // A person and a name left over on "mine", dates on "other": ignored.
  const mine = await go.setOwner({ device: cam, owner: "mine", name: "x", personId: null, from: "2025-01-01" });
  assert.deepEqual([mine?.owner_name, mine?.owned_from], [null, "2025-01-01"]);
  const other = await go.setOwner({ device: cam, owner: "other", name: "Emeric", from: "2025-01-01" });
  assert.deepEqual([other?.owner_name, other?.owned_from], ["Emeric", null]);

  await assert.rejects(
    go.setOwner({ device: cam, owner: "mine", from: "2026-01-01", until: "2025-01-01" }),
    go.BadOwner,
  );
  await assert.rejects(go.setOwner({ device: body("No such camera"), owner: "mine" }), go.UnknownBody);
});

test("a person's current name wins, and deleting the person keeps the name", { skip: skipWithoutDb }, async () => {
  const cam = body("FUJIFILM X100VI");
  await shot(cam, "2024-01-01");
  const person = (await db.one<{ id: number }>(
    "INSERT INTO people (name) VALUES ($1) RETURNING id",
    [`Aymeric ${run}`],
  ))!.id;
  const stored = await go.setOwner({ device: cam, owner: "other", personId: person, name: "ignored" });
  assert.deepEqual([stored?.person_id, stored?.owner_name], [person, `Aymeric ${run}`]);
  assert.ok((await go.listNamedPeople()).some((p) => p.id === person));

  await db.q("UPDATE people SET name = $2 WHERE id = $1", [person, `Aymeric D ${run}`]);
  assert.equal((await go.listOwners()).get(cam)?.owner_name, `Aymeric D ${run}`);

  await db.q("DELETE FROM people WHERE id = $1", [person]);
  const after = (await go.listOwners()).get(cam);
  assert.deepEqual([after?.owner, after?.person_id, after?.owner_name], ["other", null, `Aymeric ${run}`]);
});

test("/gear's payload carries the owner and the named-by-hand tell", { skip: skipWithoutDb }, async () => {
  const { listCameras } = await import("./gear");
  const named = body("Salsa dancer");
  const real = body("SONY ILCE-7CM2");
  await shot(named, "2026-05-01", true);
  await shot(real, "2026-05-01");
  await go.setOwner({ device: real, owner: "mine" });
  const cams = await listCameras();
  const n = cams.find((c) => c.name === named)!;
  const r = cams.find((c) => c.name === real)!;
  assert.deepEqual([n.named, n.owner], [true, null]);
  assert.deepEqual([r.named, r.owner?.owner], [false, "mine"]);
});

test("the route checks its shape", { skip: skipWithoutDb }, async () => {
  const route = await import("../app/api/gear/owners/route");
  const post = (b: unknown) =>
    route.POST(new NextRequest("http://x/api/gear/owners", { method: "POST", body: JSON.stringify(b) }));
  const cam = body("OnePlus A5010");
  await shot(cam, "2025-06-01");
  assert.equal((await post({ device: cam, owner: "yours" })).status, 400);
  assert.equal((await post({ device: cam, owner: "mine", from: "01/02/2025" })).status, 400);
  assert.equal((await post({ device: body("Nothing"), owner: "mine" })).status, 400);
  const ok = await post({ device: cam, owner: "other", name: "Salsa" });
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { owner: { owner_name: string } }).owner.owner_name, "Salsa");
});

test("the viewer's row carries the filter's bucket and the body's owner", { skip: skipWithoutDb }, async () => {
  const route = await import("../app/api/assets/[id]/route");
  const cam = body("FUJIFILM GFX100RF");
  const id = await shot(cam, "2025-07-01");
  const read = async () => {
    const res = await route.GET(new Request("http://x"), { params: Promise.resolve({ id: String(id) }) });
    return ((await res.json()) as { asset: { shot_by: string; gear_owner: unknown } }).asset;
  };
  assert.deepEqual(await read().then((a) => [a.shot_by, a.gear_owner]), ["unsorted", null]);
  await go.setOwner({ device: cam, owner: "other", name: "Emeric" });
  const a = await read();
  assert.equal(a.shot_by, "others");
  assert.deepEqual(a.gear_owner, {
    owner: "other", person_id: null, owner_name: "Emeric", owned_from: null, owned_until: null,
  });
});
