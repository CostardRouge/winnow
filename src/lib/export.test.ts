// SEC-01 (docs/CODEBASE-AUDIT.md): an export's folder is derived from the name
// a user typed, and deleting the export removes that folder recursively. These
// pin that no name — dots, traversal, separators, nothing at all — can make the
// folder anything but a strict child of EXPORT_DIR.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { config } from "./config";
import { exportFolder, sanitize } from "./export";

const root = path.resolve(config.exportDir);
const NAMES = [
  ".",
  "..",
  "...",
  "./",
  "../",
  "../..",
  "/",
  "/etc",
  "a/../..",
  "..\\..",
  " .. ",
  "",
  "\u0000",
  "Trip — Lisbon 2026",
];

test("sanitize never yields a name that path.join treats as . or ..", () => {
  for (const n of NAMES) {
    const s = sanitize(n);
    assert.ok(s.length > 0, `empty for ${JSON.stringify(n)}`);
    assert.ok(!/^\.+$/.test(s), `${JSON.stringify(n)} -> ${JSON.stringify(s)}`);
    assert.ok(!s.includes("/") && !s.includes("\\"), `${JSON.stringify(n)} -> ${s}`);
  }
});

test("every export folder is a strict child of EXPORT_DIR", () => {
  for (const n of NAMES) {
    const dir = exportFolder(n);
    assert.equal(path.dirname(dir), root, `${JSON.stringify(n)} -> ${dir}`);
    assert.notEqual(dir, root, JSON.stringify(n));
  }
});

test("ordinary names keep the folder they always had", () => {
  // Existing exports must still find their folder after this change.
  assert.equal(sanitize("Trip — Lisbon 2026"), "Trip_Lisbon_2026");
  assert.equal(sanitize("2026-09-30_keepers"), "2026-09-30_keepers");
  assert.equal(sanitize("v1.2"), "v1.2");
  assert.equal(sanitize(""), "export");
  assert.equal(exportFolder("keepers"), path.join(root, "keepers"));
});
