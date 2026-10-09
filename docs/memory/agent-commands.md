# Agent commands — the registry and the MCP server

Read when you touch `src/lib/commands/`, `src/scripts/mcp.ts`, or anything that would let a script or an agent DRIVE the library.

## Every agent-facing verb is a COMMAND, with Atelier's shapes (2026-10-09)

**Decision.** The maintainer asked for LightCraft's idea (`storytold/lightcraft`: every gesture a command with a stable dotted id and JSON params, one dispatch door for UI, CLI and MCP) in all three of his projects, on ONE set of conventions so an agent finds the same shapes everywhere. `src/lib/commands/registry.ts` is a port of Atelier's `src/shared/commands/registry.ts` (`docs/memory/agent-commands.md` there): `{id, title, description, params, available, run}`; params a small typed subset (number with min/max/integer, string with enum, boolean, strings, object) → JSON Schema by `paramsJsonSchema`; out of range REFUSED, never clamped; an unknown key refused naming the known ones; `available()` answers `true` or the REASON; errors coded `unknown · unavailable · invalid · failed`; a picture is an `ImageResult` (`kind: 'image'`, base64).

**Where it differs, on purpose**: `available()` may be async (a Winnow command asks the instance whether the Timeline is on or the token may write), so `list()` is async; there is no `subscribe`/`waitForCommand` (nothing mounts here); `ImageResult.mimeType` also takes `image/webp`, Winnow's derivative format. **How to apply**: keep the two files' shapes in step — a new param type or error code is added to Atelier's and this one together, or an agent driving both meets two dialects.
