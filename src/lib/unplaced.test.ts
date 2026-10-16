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

// No Redis in a test: the geocoder queue stays off.
useTestDatabase({ GEOCODE_ENABLED: "false" });

let up: typeof import("./unplaced");
let db: typeof import("./db");
let rootId: number;
let camId: number;
let clashId: number;
let lonelyId: number;
let roadId: number;
let importId: number;
let mixedId: number;
let bracketId: number;
let oneSideId: number;
let splitId: number;
let gradedIds: Record<string, number> = {};
let seq = 0;

const MPL = { lat: 43.6108, lon: 3.8767 };
const SETE = { lat: 43.4028, lon: 3.6928 };
const PEROLS = { lat: 43.5653, lon: 3.9536 };
const PORTO = { lat: 41.1496, lon: -8.611 };
const MELBOURNE = { lat: -37.8136, lon: 144.9631 };

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

// A media written field by field — the set-aside rules read the file name,
// the extension, the lens and the model the FILE declares.
async function raw(
  sid: number,
  at: string,
  o: {
    filename: string;
    ext: string;
    lens?: string | null;
    modelExif?: string | null;
    model?: string | null;
    gps?: { lat: number; lon: number };
    media?: "photo" | "video";
  },
): Promise<number> {
  seq++;
  const r = await db.one<{ id: string }>(
    `INSERT INTO assets (session_id, abs_path, rel_path, filename, ext, media_type,
                         captured_at, gps, camera_model, camera_model_exif, lens)
     VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::jsonb, $9, $10, $11) RETURNING id`,
    [
      sid,
      `/unplaced-test/${seq}/${o.filename}`,
      `${seq}/${o.filename}`,
      o.filename,
      o.ext,
      o.media ?? "photo",
      at,
      o.gps ? JSON.stringify(o.gps) : null,
      o.model === undefined ? "ILCE-7CM2" : o.model,
      o.modelExif === undefined ? "ILCE-7CM2" : o.modelExif,
      o.lens === undefined ? "FE 24-105mm F4 G OSS" : o.lens,
    ],
  );
  return Number(r!.id);
}

const AMS = { lat: 52.3731, lon: 4.8922 };
const ZAANDAM = { lat: 52.4389, lon: 4.8262 };
const KYANCUTTA = { lat: -33.1333, lon: 135.5667 };
const VENUS = { lat: -33.2333, lon: 134.6667 };

const at = (h: number, m = 0) =>
  `1999-06-01T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`;
const day6 = (h: number, m = 0) =>
  `1999-06-06T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`;

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

  // A drone folder whose located neighbours disagree: frames in Porto, then
  // in Melbourne two hours later — one source with a wrong clock.
  clashId = await session("clash", "1999-06-10T10:00:00Z", "1999-06-10T13:00:00Z");
  for (const h of [10, 11, 12, 13]) await media(clashId, `1999-06-10T${h}:00:00Z`);
  const witnesses = await session("witnesses", "1999-06-10T10:00:00Z", "1999-06-10T13:00:00Z");
  for (const [h, m] of [[10, 0], [10, 20], [10, 40]])
    await media(witnesses, `1999-06-10T${h}:${String(m).padStart(2, "0")}:00Z`, { gps: PORTO, model: "iPhone" });
  for (const [h, m] of [[12, 40], [12, 50], [13, 0]])
    await media(witnesses, `1999-06-10T${h}:${String(m).padStart(2, "0")}:00Z`, { gps: MELBOURNE, model: "OnePlus" });

  // A folder the maintainer placed two days earlier, by accepting a suggestion.
  const earlier = await session("earlier", "1999-05-30T09:00:00Z", "1999-05-30T10:00:00Z");
  for (let i = 0; i < 3; i++)
    await media(earlier, `1999-05-30T09:0${i}:00Z`, { gps: PEROLS, source: "inferred" });

  // A folder three days after the towns, with no frame located near it: the
  // nearest human placement is the Pérols folder (the phone's fixes are not
  // placements).
  lonelyId = await session("lonely", "1999-06-04T10:00:00Z", "1999-06-04T11:00:00Z");
  await media(lonelyId, "1999-06-04T10:00:00Z");
  await media(lonelyId, "1999-06-04T11:00:00Z");

  // An applied GPS import with its fixes kept (0052): Montpellier in the
  // morning, Sète in the afternoon, every 20 minutes.
  const imp = await db.one<{ id: string }>(
    `INSERT INTO track_imports (name, kind, span_start, span_end, point_count, report)
     VALUES ('test trip', 'gpx', $1, $2, 0, '{"match":{"maxBracketMin":60,"maxNearestMin":15}}'::jsonb) RETURNING id`,
    [day6(9), day6(16)],
  );
  importId = Number(imp!.id);
  for (let m = 9 * 60; m <= 16 * 60; m += 20) {
    const p = m < 12 * 60 + 30 ? MPL : SETE;
    await db.q("INSERT INTO track_points (import_id, t, lat, lon) VALUES ($1, $2, $3, $4)", [
      importId, day6(Math.floor(m / 60), m % 60), p.lat, p.lon,
    ]);
  }
  // A road-trip folder shot that day, none of it located.
  roadId = await session("road", day6(10), day6(15));
  for (const [h, m] of [[10, 0], [10, 30], [11, 0], [14, 0], [14, 30], [15, 0]])
    await media(roadId, day6(h, m));

  // §12. A phone folder of 20 June: two real frames, a screenshot (PNG, no
  // camera in the file — the attribution filled camera_model beside it) and
  // a file saved from another app. Only the two frames make the card.
  mixedId = await session("phone june", "1999-06-20T08:00:00Z", "1999-06-20T08:30:00Z");
  await raw(mixedId, "1999-06-20T08:00:00Z", { filename: "IMG_0001.HEIC", ext: ".heic", model: "iPhone 15 Pro Max", modelExif: "iPhone 15 Pro Max", lens: "iPhone 15 Pro Max back camera" });
  await raw(mixedId, "1999-06-20T08:10:00Z", { filename: "IMG_0002.HEIC", ext: ".heic", model: "iPhone 15 Pro Max", modelExif: "iPhone 15 Pro Max", lens: "iPhone 15 Pro Max back camera" });
  await raw(mixedId, "1999-06-20T08:20:00Z", { filename: "IMG_0003.PNG", ext: ".png", model: "iPhone 15 Pro Max", modelExif: null, lens: null });
  await raw(mixedId, "1999-06-20T08:30:00Z", { filename: "RSJQ2434.MP4", ext: ".mp4", model: "iPhone 15 Pro Max", modelExif: null, lens: null, media: "video" });

  // §12. Bracketing, on 22 June. One clip shot 90 s between two Sony frames at
  // the same spot (another folder): two donors only — under `floor`, so the
  // share rule alone says low.
  bracketId = await session("one clip", "1999-06-22T12:00:00Z", "1999-06-22T12:00:00Z");
  await raw(bracketId, "1999-06-22T12:00:00Z", { filename: "C0236.MP4", ext: ".mp4", media: "video" });
  const sony = await session("sony 22", "1999-06-22T11:58:30Z", "1999-06-22T15:01:00Z");
  await raw(sony, "1999-06-22T11:58:30Z", { filename: "DSC03550.HIF", ext: ".hif", gps: AMS });
  await raw(sony, "1999-06-22T12:01:34Z", { filename: "DSC03551.ARW", ext: ".arw", gps: { lat: AMS.lat + 0.0002, lon: AMS.lon } });
  // One side only, on a day of its own: a clip at 14:00, a frame located 20
  // min before, nothing after.
  oneSideId = await session("one side", "1999-06-24T14:00:00Z", "1999-06-24T14:00:00Z");
  await raw(oneSideId, "1999-06-24T14:00:00Z", { filename: "C0240.MP4", ext: ".mp4", media: "video" });
  const sony24 = await session("sony 24", "1999-06-24T13:40:00Z", "1999-06-24T13:40:00Z");
  await raw(sony24, "1999-06-24T13:40:00Z", { filename: "DSC03600.ARW", ext: ".arw", gps: AMS });
  // Sides 8 km apart decide nothing: a clip at 15:00 between Amsterdam and Zaandam.
  splitId = await session("split", "1999-06-22T15:00:00Z", "1999-06-22T15:00:00Z");
  await raw(splitId, "1999-06-22T15:00:00Z", { filename: "C0250.MP4", ext: ".mp4", media: "video" });
  await raw(sony, "1999-06-22T14:59:00Z", { filename: "DSC03700.ARW", ext: ".arw", gps: AMS });
  await raw(sony, "1999-06-22T15:01:00Z", { filename: "DSC03701.ARW", ext: ".arw", gps: ZAANDAM });

  // §12. Graded exports, exported 15 July, shot 10 July at Kyancutta. The
  // export folder is near frames located at Venus Bay — the grading desk —
  // which a time suggestion would have offered.
  const originals = await session("drone originals", "1999-07-01T05:00:00Z", "1999-07-10T05:52:00Z");
  await raw(originals, "1999-07-10T05:52:00Z", { filename: "DJI_19990710055201_0054_D.MP4", ext: ".mp4", media: "video", gps: KYANCUTTA });
  await raw(originals, "1999-07-10T05:00:00Z", { filename: "C0001.MP4", ext: ".mp4", media: "video", gps: KYANCUTTA });
  // The same short clip name another day, elsewhere — the card counter restarted.
  await raw(originals, "1999-07-01T05:00:00Z", { filename: "C0001.MP4", ext: ".mp4", media: "video", gps: VENUS });
  // Two located clips by one name, far apart: ambiguous.
  await raw(originals, "1999-07-02T05:00:00Z", { filename: "AMBIG.MP4", ext: ".mp4", media: "video", gps: KYANCUTTA });
  await raw(originals, "1999-07-03T05:00:00Z", { filename: "AMBIG.MP4", ext: ".mp4", media: "video", gps: VENUS });
  const desk = await session("venus desk", "1999-07-15T09:00:00Z", "1999-07-15T09:30:00Z");
  for (const m of [0, 10, 20]) await raw(desk, `1999-07-15T09:${String(m).padStart(2, "0")}:00Z`, { filename: `DESK${m}.HEIC`, ext: ".heic", gps: VENUS });
  const lut = await session("december lut", "1999-07-15T09:05:00Z", "1999-07-15T09:20:00Z");
  gradedIds = {
    dji: await raw(lut, "1999-07-15T09:05:00Z", { filename: "DJI_19990710055201_0054_D_lut_19990715.mp4", ext: ".mp4", media: "video" }),
    dated: await raw(lut, "1999-07-15T09:10:00Z", { filename: "19990710_C0001_lut_19990715.mp4", ext: ".mp4", media: "video" }),
    ambiguous: await raw(lut, "1999-07-15T09:15:00Z", { filename: "AMBIG_lut_19990715.mp4", ext: ".mp4", media: "video" }),
    none: await raw(lut, "1999-07-15T09:20:00Z", { filename: "NOSUCH_lut_19990715.mp4", ext: ".mp4", media: "video" }),
  };
});

after(async () => {
  if (skipWithoutDb) return;
  await db.q(
    "DELETE FROM assets WHERE session_id IN (SELECT id FROM sessions WHERE root_id = $1)",
    [rootId],
  );
  await db.q("DELETE FROM track_imports WHERE id = $1", [importId]);
  await db.q("DELETE FROM sessions WHERE root_id = $1", [rootId]);
  await db.q("DELETE FROM roots WHERE id = $1", [rootId]);
  await db.pool.end();
});

test("a folder shot in two towns is ONE card with a stop per town", { skip: skipWithoutDb }, async () => {
  const r = await up.listUnplaced();
  const cards = r.groups.filter((g) => g.sessions[0].id === camId);
  assert.equal(cards.length, 1, JSON.stringify(cards.map((c) => c.key)));
  const [card] = cards;
  assert.equal(card.kind, "shoot");
  assert.equal(card.unplaced, 23);
  assert.deepEqual(card.siblings, []);
  const stops = card.stops!;
  assert.equal(stops.length, 2);
  const [mpl, sete] = stops;
  // 13 frames in Montpellier (10:00…12:00), 10 in Sète (13:30…15:00).
  assert.equal(mpl.unplaced, 13);
  assert.equal(sete.unplaced, 10);
  // Cut in the drive, nowhere else.
  assert.ok(Date.parse(mpl.t1) < Date.parse(at(13, 30)));
  assert.ok(Date.parse(sete.t0) > Date.parse(at(12)));
  assert.ok(Date.parse(mpl.t1) <= Date.parse(sete.t0));
  // Each its own suggestion, in its own town.
  assert.ok(Math.abs(mpl.suggestion.lat - MPL.lat) < 1e-6);
  assert.ok(Math.abs(sete.suggestion.lat - SETE.lat) < 1e-6);
  assert.equal(mpl.suggestion.located, 3);
  // A card with stops is not a one-key card.
  const { isReady } = await import("./unplacedTypes");
  assert.equal(isReady(card), false);
});

test("frames that would need a plane faster than an airliner are a conflict, not two stops", { skip: skipWithoutDb }, async () => {
  const r = await up.listUnplaced();
  const card = r.groups.find((g) => g.sessions[0].id === clashId)!;
  assert.ok(card, "the clash folder has a card");
  assert.equal(card.stops, null, "never cut between two continents");
  assert.ok(card.conflict, JSON.stringify(card));
  assert.ok(card.conflict!.km > 17000);
  assert.ok(Math.abs(card.conflict!.a.lat - PORTO.lat) < 1e-3);
  assert.ok(Math.abs(card.conflict!.b.lat - MELBOURNE.lat) < 1e-3);
  // The devices whose clocks to check.
  assert.equal(card.conflict!.a.model, "iPhone");
  assert.equal(card.conflict!.b.model, "OnePlus");
  assert.equal(card.suggestion?.confidence, "low", "never offered as a confident pin");
  const { isReady } = await import("./unplacedTypes");
  assert.equal(isReady(card), false);
});

test("a card nothing suggests names the nearest human placement", { skip: skipWithoutDb }, async () => {
  const r = await up.listUnplaced();
  const card = r.groups.find((g) => g.sessions[0].id === lonelyId)!;
  assert.ok(card, "the lonely folder has a card");
  assert.equal(card.suggestion, null);
  assert.ok(card.nearest, JSON.stringify(card));
  assert.equal(card.nearest!.folder, "earlier");
  assert.ok(Math.abs(card.nearest!.lat - PEROLS.lat) < 1e-6);
  assert.equal(card.nearest!.verified, false);
  assert.ok(card.nearest!.gap_h < 0, "the placement is before the card");
});

test("following a kept track places each frame at its own point, never over a position", { skip: skipWithoutDb }, async () => {
  const trace = await import("./unplacedTrace");
  const gp = await import("./geotagPoints");
  const sources = await trace.traceSources(day6(9), day6(16));
  const imp = sources.find((x) => x.kind === "import");
  assert.ok(imp && imp.kind === "import" && imp.id === importId, JSON.stringify(sources));

  const r = await trace.traceCard({ sessionId: roadId, from: day6(9), to: day6(16), imports: [importId], models: [] });
  assert.equal(r.frames.length, 6);
  assert.ok(r.frames.every((f) => f.source === "track" && f.import_id === importId));
  assert.equal(r.stops.length, 2, JSON.stringify(r.stops));
  assert.ok(Math.abs(r.stops[0].lat - MPL.lat) < 0.01);
  assert.ok(Math.abs(r.stops[1].lat - SETE.lat) < 0.01);
  assert.ok(r.line.length >= 2);

  const pts = r.frames.map((f) => ({ id: f.id, ...f.pos!, source: f.source!, import_id: f.import_id }));
  const w1 = await gp.writeGeotagPoints(pts);
  assert.deepEqual(w1, { updated: 6, skipped: 0 });
  const rows = await db.many<{ gps_source: string; track_import_id: string; gps_write_status: string }>(
    "SELECT gps_source, track_import_id, gps_write_status FROM assets WHERE session_id = $1",
    [roadId],
  );
  assert.ok(rows.every((x) => x.gps_source === "track" && Number(x.track_import_id) === importId && x.gps_write_status === "skipped"));
  // A second write finds every frame placed and leaves it alone.
  const w2 = await gp.writeGeotagPoints(pts.map((p) => ({ ...p, lat: 0.5, lon: 0.5 })));
  assert.deepEqual(w2, { updated: 0, skipped: 6 });
});

test("a track point naming an import that is gone is skipped, never left un-undoable", { skip: skipWithoutDb }, async () => {
  const gp = await import("./geotagPoints");
  const one = await db.one<{ id: string }>(
    "SELECT id FROM assets WHERE session_id = $1 ORDER BY captured_at LIMIT 1",
    [lonelyId],
  );
  // Import 999999 never existed (or was undone while the dialog was open).
  const w = await gp.writeGeotagPoints([
    { id: Number(one!.id), lat: MPL.lat, lon: MPL.lon, source: "track", import_id: 999999 },
  ]);
  assert.deepEqual(w, { updated: 0, skipped: 1 });
  const row = await db.one<{ gps: unknown }>("SELECT gps FROM assets WHERE id = $1", [Number(one!.id)]);
  assert.equal(row!.gps, null);
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

test("screenshots and files saved from another app are on no card, and counted aside", { skip: skipWithoutDb }, async () => {
  const r = await up.listUnplaced();
  const card = r.groups.find((g) => g.sessions[0].id === mixedId)!;
  assert.ok(card, "the phone folder has a card");
  assert.equal(card.unplaced, 2, "the two real frames only");
  assert.ok(r.totals.aside.screenshots >= 1);
  assert.ok(r.totals.aside.saved >= 1);
  // The library tally still counts them: they are unplaced, just not a card's.
  const aside = await import("./unplacedAside");
  const list = await aside.listAside();
  const mine = list.not_a_place.filter((a) => a.session_id === mixedId);
  assert.deepEqual(mine.map((a) => [a.filename, a.kind]).sort(), [
    ["IMG_0003.PNG", "screenshot"],
    ["RSJQ2434.MP4", "saved"],
  ]);
});

test("a clip between two located frames at one spot is high, pinned on the nearer", { skip: skipWithoutDb }, async () => {
  const r = await up.listUnplaced();
  const card = r.groups.find((g) => g.sessions[0].id === bracketId)!;
  const s = card.suggestion!;
  assert.equal(s.located, 2, "under the floor: the share alone said low");
  assert.equal(s.confidence, "high");
  assert.equal(s.evidence?.basis, "bracketed");
  assert.equal(s.evidence?.before?.filename, "DSC03550.HIF");
  assert.equal(s.evidence?.after?.filename, "DSC03551.ARW");
  assert.ok(Math.abs(s.lat - AMS.lat) < 1e-6, "90 s before is nearer than 94 s after");

  const one = r.groups.find((g) => g.sessions[0].id === oneSideId)!.suggestion!;
  assert.equal(one.confidence, "medium");
  assert.equal(one.evidence?.basis, "one_side");

  const split = r.groups.find((g) => g.sessions[0].id === splitId)!.suggestion!;
  assert.equal(split.evidence ?? null, null, "8 km apart decides nothing");
  assert.equal(split.confidence, "low");
});

test("graded exports are on no card and find their source by name and shoot day", { skip: skipWithoutDb }, async () => {
  const r = await up.listUnplaced();
  assert.ok(!r.groups.some((g) => g.sessions[0].name === "december lut"), "never a card: its hours are the grading desk's");
  assert.ok(r.totals.aside.graded >= 4);
  assert.ok(r.totals.aside.graded_matched >= 2);

  const aside = await import("./unplacedAside");
  const { graded } = await aside.listAside();
  const by = new Map(graded.map((x) => [x.id, x]));
  const dji = by.get(gradedIds.dji)!;
  assert.ok(dji.source, JSON.stringify(dji));
  assert.ok(Math.abs(dji.source!.lat - KYANCUTTA.lat) < 1e-6);
  // C0001 was shot twice; the one shot on the name's date (10 July) answers.
  const dated = by.get(gradedIds.dated)!;
  assert.ok(dated.source, JSON.stringify(dated));
  assert.ok(Math.abs(dated.source!.lat - KYANCUTTA.lat) < 1e-6, "not the Venus Bay C0001 of 1 July");
  assert.equal(by.get(gradedIds.ambiguous)!.reason, "ambiguous");
  assert.equal(by.get(gradedIds.none)!.reason, "none");

  // Copied as a suggestion, never written into the file, never over a position.
  const gp = await import("./geotagPoints");
  const w = await gp.writeGeotagPoints([
    { id: dji.id, lat: dji.source!.lat, lon: dji.source!.lon, source: "inferred", import_id: null },
  ]);
  assert.deepEqual(w, { updated: 1, skipped: 0 });
  const row = await db.one<{ gps_source: string; gps_write_status: string | null }>(
    "SELECT gps_source, gps_write_status FROM assets WHERE id = $1",
    [dji.id],
  );
  assert.equal(row!.gps_source, "inferred");
  assert.notEqual(row!.gps_write_status, "pending");
});
