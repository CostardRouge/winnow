// The session page's filters, against a real database:
//   - /api/facets?session_id=N counts that session's media only, so the
//     session page's panel lists what the folder holds (a city shot in
//     another folder is not a chip there), while the unscoped call still sees
//     both sessions;
//   - /api/sessions/:id/assets applies the gallery's filters (type, place,
//     tags) inside the session and never reaches outside it.
// Database-backed: runs only with WINNOW_TEST_DATABASE_URL. Rows carry a
// run-scoped path, city and tag so files sharing the database never collide.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { skipWithoutDb, useTestDatabase } from "../test/db";

useTestDatabase();

let db: typeof import("./db");
let rootId: number;
let sessionA: number;
let sessionB: number;
let seq = 0;
const run = `${process.pid}-${Date.now()}`;
const city = (name: string) => `${name} ${run}`;
const tag = `beach ${run}`;

/** A medium in `session`, of `type`, shot in `place`; returns its id. */
async function medium(
  session: number,
  type: "photo" | "video",
  place: string,
): Promise<number> {
  seq++;
  return (await db.one<{ id: number }>(
    `INSERT INTO assets (session_id, abs_path, rel_path, filename, ext, media_type,
                         captured_at, place_city)
     VALUES ($1, $2, $3, $3, $4, $5,
             '2026-01-01T12:00:00Z'::timestamptz + make_interval(secs => $6), $7)
     RETURNING id`,
    [
      session,
      `/session-filters-test-${run}/f${seq}`,
      `f${seq}`,
      type === "video" ? ".mp4" : ".jpg",
      type,
      seq * 60,
      place,
    ],
  ))!.id;
}

let aPhoto: number;
let aVideo: number;
let aTagged: number;

before(async () => {
  if (skipWithoutDb) return;
  db = await import("./db");
  rootId = (await db.one<{ id: number }>(
    "INSERT INTO roots (path, kind, watch) VALUES ($1, 'source', false) RETURNING id",
    [`/session-filters-test-${run}`],
  ))!.id;
  const session = async (name: string) =>
    (await db.one<{ id: number }>(
      "INSERT INTO sessions (root_id, name, source_path) VALUES ($1, $2, $3) RETURNING id",
      [rootId, name, `/session-filters-test-${run}/${name}`],
    ))!.id;
  sessionA = await session("a");
  sessionB = await session("b");

  aPhoto = await medium(sessionA, "photo", city("Noosa"));
  aVideo = await medium(sessionA, "video", city("Noosa"));
  aTagged = await medium(sessionA, "photo", city("Tewantin"));
  await medium(sessionB, "video", city("Brisbane"));
  await medium(sessionB, "photo", city("Brisbane"));

  const tagId = (await db.one<{ id: number }>(
    "INSERT INTO tags (name) VALUES ($1) RETURNING id",
    [tag],
  ))!.id;
  await db.q("INSERT INTO asset_tags (asset_id, tag_id) VALUES ($1, $2)", [
    aTagged,
    tagId,
  ]);
});

after(async () => {
  if (skipWithoutDb) return;
  await db.q("DELETE FROM assets WHERE session_id = ANY($1)", [[sessionA, sessionB]]);
  await db.q("DELETE FROM tags WHERE name = $1", [tag]);
  await db.q("DELETE FROM sessions WHERE id = ANY($1)", [[sessionA, sessionB]]);
  await db.q("DELETE FROM roots WHERE id = $1", [rootId]);
  await db.pool.end();
});

type VC = { value: string | number; count: number };
type FacetsBody = {
  total: number;
  media_types: VC[];
  place_cities: VC[];
  tags: VC[];
};

async function facets(qs: string): Promise<FacetsBody> {
  const route = await import("../app/api/facets/route");
  const res = await route.GET(new NextRequest(`http://test/api/facets?${qs}`));
  assert.equal(res.status, 200);
  return (await res.json()) as FacetsBody;
}

/** Only this run's cities, as `name → count`. */
function ours(list: VC[]): Record<string, number> {
  return Object.fromEntries(
    list.filter((v) => String(v.value).endsWith(run)).map((v) => [v.value, v.count]),
  );
}

async function sessionIds(session: number, qs: string): Promise<number[]> {
  const route = await import("../app/api/sessions/[id]/assets/route");
  const res = await route.GET(
    new NextRequest(`http://test/api/sessions/${session}/assets?${qs}`),
    { params: Promise.resolve({ id: String(session) }) },
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { assets: { id: number }[] };
  return body.assets.map((a) => a.id).sort((x, y) => x - y);
}

test("facets scoped to a session count that session only", { skip: skipWithoutDb }, async () => {
  const a = await facets(`session_id=${sessionA}`);
  assert.equal(a.total, 3);
  assert.deepEqual(ours(a.place_cities), {
    [city("Noosa")]: 2,
    [city("Tewantin")]: 1,
  });
  const types = Object.fromEntries(a.media_types.map((v) => [v.value, v.count]));
  assert.deepEqual(types, { photo: 2, video: 1 });
  assert.deepEqual(
    a.tags.filter((t) => t.value === tag),
    [{ value: tag, count: 1 }],
  );

  // The library-wide call still sees the other session's city.
  const all = await facets("");
  assert.equal(ours(all.place_cities)[city("Brisbane")], 2);
});

test("the session grid applies the gallery's filters inside the session", { skip: skipWithoutDb }, async () => {
  assert.deepEqual(await sessionIds(sessionA, "media_type=video"), [aVideo]);
  assert.deepEqual(
    await sessionIds(sessionA, `place_city=${encodeURIComponent(city("Noosa"))}`),
    [aPhoto, aVideo].sort((x, y) => x - y),
  );
  assert.deepEqual(
    await sessionIds(sessionA, `tags=${encodeURIComponent(tag)}`),
    [aTagged],
  );
  // A filter naming another session's place finds nothing here.
  assert.deepEqual(
    await sessionIds(sessionA, `place_city=${encodeURIComponent(city("Brisbane"))}`),
    [],
  );
});
