/**
 * The agent BRIDGE's own version — v1, v2, v3… — the one number a person
 * reads to know which bridge runs on their computer and whether the instance
 * serves a newer one. Ported from Atelier's `shared/commands/bridge-version.ts`
 * (2026-10-11): the extension's manifest used to say package.json's `0.1.0`,
 * never bumped, so every new download looked the same to Claude Desktop, which
 * offered to uninstall instead of to update.
 *
 * It counts changes to what is INSTALLED on the computer: every source file
 * scripts/build-agent-bridge.ts bundles into `winnow-mcp.mjs` (the entry
 * `src/scripts/mcp.ts` and what it imports — the protocol, the registry and
 * the commands). Unlike Atelier's, Winnow's commands live IN the bridge, so a
 * new or changed command is a new bridge too.
 *
 * `BRIDGE_SOURCE_HASH` is the SHA-256 of those files as this version shipped
 * them; `bridgeVersion.test.ts` recomputes it from esbuild's own list of
 * inputs, so a change to the bridge that forgets to bump the number fails the
 * tests and says what to write.
 *
 * Imports nothing: the bridge bundles it, the instance serves its number on
 * /api/capabilities, and the build script stamps the manifest from it.
 */

export const BRIDGE_VERSION = 1;

/** SHA-256 of every source file bundled into the bridge but this one, sorted by path, line endings normalised. */
export const BRIDGE_SOURCE_HASH = "345fd324eaf4c5b255ab930bcfbabbea0ea927bdf9a2bb0da248a1d0730365be";

/** What each version changed, newest first — drawn on Users › Agents. */
export const BRIDGE_CHANGES: readonly { version: number; date: string; changes: readonly string[] }[] = [
  {
    version: 1,
    date: "2026-10-11",
    changes: [
      "The first numbered bridge: from here on, a new number is offered by Claude Desktop as an Update.",
      "winnow_status says which bridge runs and whether this instance serves a newer one.",
      "Culling, trash, tags and people commands; up to 12 pictures compared in one call.",
    ],
  },
];

/** The version as people read it: "v4". */
export function bridgeLabel(version: number | null | undefined): string {
  return typeof version === "number" && version > 0 ? `v${version}` : "unnumbered";
}

/** The version as a manifest and MCP's serverInfo want it: semver, so Claude Desktop orders updates. */
export function bridgeSemver(version: number = BRIDGE_VERSION): string {
  return `${version}.0.0`;
}

/** The name a download of the extension is saved under, so two downloads are told apart. */
export function extensionFileName(version: number = BRIDGE_VERSION): string {
  return `winnow-${bridgeLabel(version)}.mcpb`;
}
