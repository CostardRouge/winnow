// lib/timeline.ts against a real database: the chapter bounds leave the
// derivation in ISO form. The regression: they left in pg's text form
// ("1997-05-04 10:00:00.250123+00"), the page posted them back unchanged to
// name a chapter, and the span route's `datetime()` refused every one —
// "Invalid span" on any edit of a derived chapter; Safari could not parse them
// either. Database-backed: runs only with WINNOW_TEST_DATABASE_URL (a migrated
// scratch database). Invented fixtures, dated 1997.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { skipWithoutDb, useTestDatabase } from "../test/db";

useTestDatabase({ GEOCODE_ENABLED: "false" });

let tl: typeof import("./timeline");
let db: typeof import("./db");
let rootId: number;
let sid: number;

// The span route's own check (api/timeline/chapters, not exportable there).
const spanInstant = z.string().datetime({ offset: true });

before(async () => {
  if (skipWithoutDb) return;
  tl = await import("./timeline");
  db = await import("./db");
  const root = await db.one<{ id: number }>(
    "INSERT INTO roots (path, kind, watch) VALUES ('/timeline-test', 'source', false) RETURNING id",
  );
  rootId = root!.id;
  const s = await db.one<{ id: number }>(
    `INSERT INTO sessions (root_id, name, source_path, captured_at_min, captured_at_max)
     VALUES ($1, 'may day', '/timeline-test/may day', '1997-05-04 10:00:00+00', '1997-05-04 12:00:00+00')
     RETURNING id`,
    [rootId],
  );
  sid = s!.id;
  // Sub-millisecond instants on purpose: the end must round UP to stay a bound.
  const times = ["1997-05-04 10:00:00.250123+00", "1997-05-04 11:00:00+00", "1997-05-04 12:00:00.999501+00"];
  for (const [i, at] of times.entries()) {
    await db.q(
      `INSERT INTO assets (session_id, abs_path, rel_path, filename, ext, media_type, captured_at)
       VALUES ($1, $2, $3, $3, 'arw', 'photo', $4::timestamptz)`,
      [sid, `/timeline-test/T${i}.arw`, `T${i}.arw`, at],
    );
  }
});

after(async () => {
  if (skipWithoutDb) return;
  await db.q("DELETE FROM assets WHERE session_id = $1", [sid]);
  await db.q("DELETE FROM sessions WHERE id = $1", [sid]);
  await db.q("DELETE FROM roots WHERE id = $1", [rootId]);
  await db.pool.end();
});

test("a chapter's bounds are ISO instants the span route accepts", { skip: skipWithoutDb }, async () => {
  const { chapters } = await tl.deriveTimeline({ session_id: sid }, { ...tl.TIMELINE_DEFAULTS, mode: "time" });
  assert.equal(chapters.length, 1);
  const [ch] = chapters;
  assert.equal(ch.started_at, "1997-05-04T10:00:00.250Z");
  assert.equal(ch.ended_at, "1997-05-04T12:00:01.000Z");
  assert.equal(ch.key, ch.started_at);
  assert.ok(spanInstant.safeParse(ch.started_at).success);
  assert.ok(spanInstant.safeParse(ch.ended_at).success);
});
