// The bridge's number moves whenever what people install moves: the hash of
// every source file esbuild bundles into winnow-mcp.mjs (its own list of
// inputs, so a newly imported file is counted without anyone listing it) must
// match BRIDGE_SOURCE_HASH, or the bridge changed without a new number —
// Claude Desktop would then never offer the update (Atelier's
// bridge-version.test.ts, the same rule).
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bridgeSourceHash, bumpAdvice } from "./bridgeHash";
import { bridgeStatus } from "./winnow";
import {
  BRIDGE_CHANGES,
  BRIDGE_SOURCE_HASH,
  BRIDGE_VERSION,
  bridgeLabel,
  bridgeSemver,
  extensionFileName,
} from "./bridgeVersion";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("the bridge number is bumped whenever the bridge changes", async () => {
  const now = await bridgeSourceHash(root);
  assert.equal(now, BRIDGE_SOURCE_HASH, bumpAdvice(BRIDGE_VERSION, now));
});

test("every version has a changelog entry, newest first", () => {
  assert.equal(BRIDGE_CHANGES[0].version, BRIDGE_VERSION);
  BRIDGE_CHANGES.forEach((entry, i) => {
    assert.equal(entry.version, BRIDGE_VERSION - i);
    assert.ok(entry.changes.length > 0);
    assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/);
  });
});

test("the number reads as people, files and Claude Desktop want it", () => {
  assert.equal(bridgeLabel(4), "v4");
  assert.equal(bridgeLabel(null), "unnumbered");
  assert.equal(bridgeSemver(4), "4.0.0");
  assert.equal(extensionFileName(4), "winnow-v4.mcpb");
});

test("winnow_status says which bridge runs and when a newer one is served", () => {
  assert.deepEqual(bridgeStatus(BRIDGE_VERSION), {
    bridge: bridgeLabel(BRIDGE_VERSION),
    latestBridge: bridgeLabel(BRIDGE_VERSION),
  });
  const behind = bridgeStatus(BRIDGE_VERSION + 1);
  assert.equal(behind.latestBridge, bridgeLabel(BRIDGE_VERSION + 1));
  assert.match(behind.update, /Users › Agents/);
  // An instance from before numbering says nothing: no claim either way.
  assert.deepEqual(bridgeStatus(undefined), { bridge: bridgeLabel(BRIDGE_VERSION) });
});
