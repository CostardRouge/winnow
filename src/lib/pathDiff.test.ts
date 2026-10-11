import { test } from "node:test";
import assert from "node:assert/strict";
import { splitPaths } from "./pathDiff";

const join = (p: { prefix: string; rest: string; file: string }) =>
  p.prefix + p.rest + p.file;

test("the folder that differs is isolated from the shared prefix", () => {
  const [a, b] = splitPaths([
    "/nas/incoming/2024/2024-06-12 Tokyo/DSC04812.ARW",
    "/nas/incoming/_backup-card-A/DCIM/100MSDCF/DSC04812.ARW",
  ]);
  assert.equal(a.prefix, "/nas/incoming/");
  assert.equal(a.rest, "2024/2024-06-12 Tokyo/");
  assert.equal(b.rest, "_backup-card-A/DCIM/100MSDCF/");
  assert.equal(a.fileDiffers, false);
});

test("a shared file name never joins the prefix", () => {
  // Same folder depth and same file: only the folder differs.
  const [a, b] = splitPaths(["/a/x/f.jpg", "/a/y/f.jpg"]);
  assert.deepEqual([a.prefix, a.rest, a.file], ["/a/", "x/", "f.jpg"]);
  assert.deepEqual([b.prefix, b.rest, b.file], ["/a/", "y/", "f.jpg"]);
});

test("copies in the same folder differ by file name", () => {
  const parts = splitPaths(["/nas/in/DSC0001.ARW", "/nas/in/DSC0001 (1).ARW"]);
  for (const p of parts) {
    assert.equal(p.prefix, "/nas/in/");
    assert.equal(p.rest, "");
    assert.equal(p.fileDiffers, true);
  }
});

test("a nested copy keeps the extra folder in its rest", () => {
  const [a, b] = splitPaths([
    "/nas/incoming/2024/2024-09 Dolomites/_DSC1180.ARW",
    "/nas/incoming/2024/2024-09 Dolomites/selects/_DSC1180.ARW",
  ]);
  assert.equal(a.prefix, "/nas/incoming/2024/2024-09 Dolomites/");
  assert.equal(a.rest, "");
  assert.equal(b.rest, "selects/");
});

test("a lone path is all prefix, and every split rejoins to its input", () => {
  const [solo] = splitPaths(["/nas/finals/2024/Japan/DSC04877.jpg"]);
  assert.deepEqual(
    [solo.prefix, solo.rest, solo.file],
    ["/nas/finals/2024/Japan/", "", "DSC04877.jpg"],
  );
  const inputs = ["/x/a/b/c.ARW", "/x/a/c.ARW", "/y/c.ARW", "rel/c.ARW"];
  splitPaths(inputs).forEach((p, i) => assert.equal(join(p), inputs[i]));
});
