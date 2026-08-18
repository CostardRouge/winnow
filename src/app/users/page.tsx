import type { Metadata } from "next";
import UsersPanel from "./UsersPanel";

// Admin-only user management (the request guard redirects everyone else):
// accounts of the shared library, each with a role — viewer (browse), editor
// (cull/import/export), admin (infrastructure + this page).
export const metadata: Metadata = { title: "Users" };

export default function UsersPage() {
  return (
    <div className="app-shell">
      <div className="topbar">
        <h1>Users</h1>
        <span className="hint">accounts &amp; roles of the shared library</span>
      </div>
      <div className="pipeline-body">
        <UsersPanel />
      </div>
    </div>
  );
}
