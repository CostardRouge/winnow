// The hash that pins the bridge's number to its source (bridgeVersion.ts):
// every source file esbuild bundles into winnow-mcp.mjs — esbuild's own list
// of inputs, so a newly imported file is counted without anyone listing it —
// sorted, line endings normalised, bridgeVersion.ts itself left out (it is
// where the hash is written; counting it would make the hash chase its tail).
//
// Node-only (esbuild, fs): used by scripts/build-agent-bridge.ts, which FAILS
// the build in CI when the bridge changed without a new number (npm test is
// not in CI yet — CODEBASE-AUDIT D8 — the build is), and by
// bridgeVersion.test.ts. Never imported by the bridge itself.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

export const BRIDGE_ENTRY = "src/scripts/mcp.ts";

export async function bridgeSourceHash(root: string): Promise<string> {
  const out = await build({
    absWorkingDir: root,
    entryPoints: [BRIDGE_ENTRY],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node18",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  const inputs = Object.keys(out.metafile.inputs)
    .filter((f) => !f.endsWith("lib/commands/bridgeVersion.ts"))
    .sort();
  const hash = createHash("sha256");
  for (const file of inputs) {
    hash.update(`${file}\n`);
    hash.update(readFileSync(join(root, file), "utf8").replace(/\r\n/g, "\n"));
  }
  return hash.digest("hex");
}

/** What to write when the hash moved — the same sentence in the build and the test. */
export function bumpAdvice(version: number, now: string): string {
  return (
    `The agent bridge changed (src/scripts/mcp.ts or a file it bundles, src/lib/commands/…). ` +
    `In src/lib/commands/bridgeVersion.ts: bump BRIDGE_VERSION to ${version + 1}, ` +
    `add its entry to BRIDGE_CHANGES, and set BRIDGE_SOURCE_HASH to "${now}". ` +
    `(Only the hash, if this change must not make people reinstall — a comment, a typo.)`
  );
}
