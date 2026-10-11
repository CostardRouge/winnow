/**
 * Builds the agent bridge the instance serves, so connecting Claude needs a
 * download and no checkout of this repository:
 *
 *   public/agent/winnow-mcp.mjs — src/scripts/mcp.ts and src/lib/commands/
 *     bundled into ONE plain-JavaScript file (Node ≥ 18, no dependency):
 *     `claude mcp add … -- node ~/.winnow/winnow-mcp.mjs`;
 *   public/agent/winnow.mcpb — the same file plus a manifest, zipped: a
 *     Claude Desktop extension that installs from a dialog and asks for the
 *     address and the token itself (lib/commands/mcp.ts, mcpbManifest).
 *
 * Atelier ships its bridge the same two ways (its vite.config.ts,
 * `agentBridgePlugin`). Generated at every `npm run build` / `npm run dev`,
 * never committed (public/agent/ is gitignored): a copy in git would drift
 * from the commands the instance's own API answers. The proxy matcher lets
 * /agent/ through without a session — the files are this public repository's
 * code and hold no secret; the token never leaves the user's machine.
 *
 * esbuild arrives with tsx (a runtime dependency), so this adds none.
 * Run: `npx tsx scripts/build-agent-bridge.ts`.
 */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zipStore } from "../src/lib/zipStore";
import { MCPB_ENTRY, mcpbManifest } from "../src/lib/commands/mcp";
import {
  BRIDGE_SOURCE_HASH,
  BRIDGE_VERSION,
  bridgeLabel,
  bridgeSemver,
} from "../src/lib/commands/bridgeVersion";
import { bridgeSourceHash, bumpAdvice } from "../src/lib/commands/bridgeHash";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "public", "agent");

function commit(): string | null {
  // CI and the Docker build carry no .git in every case; a missing sha is
  // not an error, the version just says less.
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

// The bridge's OWN number (v1, v2… — lib/commands/bridgeVersion), not the
// site's: it moves only when the bridge does, so Claude Desktop offers an
// Update exactly then. package.json's version never moved, which is why every
// download used to look like the installed one. The commit only rides in the
// banner, for whoever reads the file.
//
// A bridge that changed without a new number would reach people as the "same"
// extension: in CI (which runs this through `npm run build`, while `npm test`
// is not in CI yet) that fails the build; locally it only warns, so a dev
// server still starts mid-edit.
const now = await bridgeSourceHash(root);
if (now !== BRIDGE_SOURCE_HASH) {
  const advice = bumpAdvice(BRIDGE_VERSION, now);
  if (process.env.CI) {
    console.error(advice);
    process.exit(1);
  }
  console.warn(`warning: ${advice}`);
}
const version = bridgeSemver(BRIDGE_VERSION);
const sha = commit();
const label = `${bridgeLabel(BRIDGE_VERSION)}${sha ? ` (site ${sha})` : ""}`;

const out = await build({
  entryPoints: [join(root, "src", "scripts", "mcp.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  write: false,
  logLevel: "silent",
  banner: { js: `// Winnow MCP bridge ${label} — generated from src/scripts/mcp.ts; do not edit.` },
});
const code = out.outputFiles[0].text;

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, "winnow-mcp.mjs"), code);
await writeFile(
  join(outDir, "winnow.mcpb"),
  zipStore([
    // The manifest's version must be plain semver: N.0.0 for bridge vN.
    { name: "manifest.json", data: JSON.stringify(mcpbManifest(version), null, 2) },
    { name: MCPB_ENTRY, data: code },
  ]),
);
console.log(`agent bridge ${label}: public/agent/winnow-mcp.mjs (${(code.length / 1024).toFixed(1)} KB), winnow.mcpb`);
