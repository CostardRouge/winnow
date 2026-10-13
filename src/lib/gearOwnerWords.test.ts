// The viewer's "whose camera shot THIS frame" line (lib/gearOwnerWords.ts):
// nothing for an unsorted body, the owner's name for someone else's, and the
// side of the span for a body of mine that was not mine on that day.
import { test } from "node:test";
import assert from "node:assert/strict";
import { shotByLine, spanDate } from "./gearOwnerWords";
import type { GearOwner } from "./gearTypes";

const owner = (o: Partial<GearOwner>): GearOwner => ({
  owner: "mine", person_id: null, owner_name: null,
  owned_from: null, owned_until: null, ...o,
});

test("an unsorted body, or no body at all, says nothing", () => {
  assert.equal(shotByLine("unsorted", null, "2020-01-01T12:00:00Z"), null);
  assert.equal(shotByLine("none", null, null), null);
  assert.equal(shotByLine(undefined, undefined, null), null);
});

test("mine, someone else's, not a camera", () => {
  assert.deepEqual(shotByLine("me", owner({}), null), { kind: "mine", text: "mine" });
  assert.deepEqual(
    shotByLine("others", owner({ owner: "other", owner_name: "Aymeric" }), null),
    { kind: "other", text: "Aymeric’s" },
  );
  assert.deepEqual(
    shotByLine("others", owner({ owner: "other" }), null),
    { kind: "other", text: "someone else’s" },
  );
  assert.deepEqual(shotByLine("none", owner({ owner: "none" }), null), {
    kind: "none", text: "not a camera",
  });
});

test("a body of mine outside its span says which side", () => {
  const phone = owner({ owned_from: "2013-07-01", owned_until: "2016-03-31" });
  assert.deepEqual(shotByLine("others", phone, "2013-06-30T12:00:00Z"), {
    kind: "other", text: "before it was yours (since Jul 2013)",
  });
  assert.deepEqual(shotByLine("others", phone, "2016-04-01T12:00:00Z"), {
    kind: "other", text: "after it was yours (until Mar 2016)",
  });
});

test("span dates use the app's month table, not the browser's", () => {
  assert.equal(spanDate("2026-09-14"), "Sep 2026");
  assert.equal(spanDate("2016-03-31"), "Mar 2016");
});
