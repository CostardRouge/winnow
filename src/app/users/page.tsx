import type { Metadata } from "next";
import UsersPanel from "./UsersPanel";

// Admin-only user management (the request guard redirects everyone else):
// accounts of the shared library, each with a role — viewer (browse), editor
// (cull/import/export), admin (infrastructure + this page). The header and the
// Accounts / App tokens tabs are the section's layout.
export const metadata: Metadata = { title: "Users" };

export default function UsersPage() {
  return <UsersPanel />;
}
