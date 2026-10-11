import type { Metadata } from "next";
import AgentsGuide from "./AgentsGuide";

// Admin-only (under /users, cf. lib/authz.ts) because step 2 mints a token,
// which only an admin may do: the walk-through for connecting Claude or any
// MCP client to this library (docs/memory/agent-commands.md).
export const metadata: Metadata = { title: "Agents" };

export default function AgentsPage() {
  return <AgentsGuide />;
}
