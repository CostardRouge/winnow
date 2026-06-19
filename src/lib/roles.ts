// Role of a folder (root), derived from `roots.kind` — single source of truth.
//   incoming = to be culled (inbox + incoming)    → kind ∈ ('source','inbox')
//   final    = already finalized, view-only        → kind = 'finals'
//
// Classification is AUTOMATIC (no manual per-folder toggle): we
// add the final folders via the config (FINALS_DIRS) or the /api/roots API,
// and everything else (scans, incoming, inbox) falls under the Incoming. Keeping this
// logic here avoids duplicating it across the UI, the filters and the SQL.
import type { Root } from "./types";

export type Role = "incoming" | "final";

export function roleForKind(kind: string): Role {
  return kind === "finals" ? "final" : "incoming";
}

// Postgres kinds corresponding to a role (for SQL `= ANY` clauses).
export function kindsForRole(role: Role): Root["kind"][] {
  return role === "final" ? ["finals"] : ["source", "inbox"];
}
