import type { Metadata } from "next";
import PageHeader from "../PageHeader";
import UsersPanel from "./UsersPanel";

// Admin-only user management (the request guard redirects everyone else):
// accounts of the shared library, each with a role — viewer (browse), editor
// (cull/import/export), admin (infrastructure + this page).
export const metadata: Metadata = { title: "Users" };

export default function UsersPage() {
  return (
    <div className="app-shell">
      <PageHeader title="Users" />
      <div className="pipeline-body">
        <UsersPanel />
      </div>
    </div>
  );
}
