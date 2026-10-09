// The bulk rule's survivor pick (autoKeep), pinned branch by branch now that
// the page prints the branch as the REASON a copy is suggested: a wrong reason
// beside a right path would be a lie the user acts on. Pure — no database: the
// function only reads the group it is handed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { autoKeep } from "./duplicateList";
import type { DuplicateCopy, DuplicateExisting } from "./duplicateTypes";

function copy(abs_path: string, view_only = false): DuplicateCopy {
  return {
    abs_path,
    source: "scan",
    hits: 1,
    file_size: 1,
    updated_at: "2026-10-09T00:00:00Z",
    view_only,
    zone: view_only ? "gallery" : "incoming",
    is_raw: false,
  };
}

function lib(
  abs_path: string | null,
  o: Partial<DuplicateExisting> = {},
): DuplicateExisting {
  return {
    id: 1,
    filename: "a.jpg",
    abs_path,
    media_type: "photo",
    has_thumb: true,
    deleted: false,
    purged: false,
    view_only: false,
    zone: "incoming",
    is_raw: false,
    ...o,
  };
}

const group = (copies: DuplicateCopy[], l: DuplicateExisting | null) => ({
  copies,
  members: copies.length + (l?.abs_path ? 1 : 0),
});

test("the one protected copy is kept, and says so", () => {
  const l = lib("/finals/a.jpg", { view_only: true, zone: "gallery" });
  assert.deepEqual(autoKeep(group([copy("/in/a.jpg")], l), l), {
    path: "/finals/a.jpg",
    rule: "protected",
  });
  // No library entry at all: the protected on-disk copy still wins.
  assert.deepEqual(
    autoKeep(group([copy("/in/a.jpg"), copy("/finals/a.jpg", true)], null), null),
    { path: "/finals/a.jpg", rule: "protected" },
  );
});

test("a live library entry with no protected copy is kept as the library", () => {
  const l = lib("/in/2024/a.jpg");
  assert.deepEqual(autoKeep(group([copy("/in/backup/a.jpg")], l), l), {
    path: "/in/2024/a.jpg",
    rule: "library",
  });
});

test("every judgement call stays manual", () => {
  // Two protected copies: neither may go.
  const twoProt = lib("/finals/a.jpg", { view_only: true });
  assert.equal(autoKeep(group([copy("/export/a.jpg", true)], twoProt), twoProt), null);
  // A protected copy that is NOT the live entry would relink it onto a view-only volume.
  const live = lib("/in/a.jpg");
  assert.equal(autoKeep(group([copy("/finals/a.jpg", true)], live), live), null);
  // An entry in the trash.
  const trashed = lib("/in/a.jpg", { deleted: true });
  assert.equal(autoKeep(group([copy("/in/b/a.jpg")], trashed), trashed), null);
  // On-disk copies only.
  assert.equal(autoKeep(group([copy("/in/a.jpg"), copy("/in/b/a.jpg")], null), null), null);
  // A lone copy is not a duplicate of anything.
  assert.equal(autoKeep(group([copy("/in/a.jpg")], null), null), null);
});
