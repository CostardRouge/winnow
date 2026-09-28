import type { Metadata } from "next";
import TokensPanel from "./TokensPanel";

// Admin-only (under /users, cf. lib/authz.ts): the app tokens a client that
// cannot hold the session cookie uses instead — Atelier from a phone's home
// screen, first.
export const metadata: Metadata = { title: "App tokens" };

export default function TokensPage() {
  return <TokensPanel />;
}
