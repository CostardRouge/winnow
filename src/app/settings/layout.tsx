import { headers } from "next/headers";
import { identityFromHeaders } from "@/lib/auth";
import PageHeader from "../PageHeader";
import SettingsNav from "./SettingsNav";

// Shared chrome for the Settings section: one header band carrying the
// heading and the sub-route tabs (Pipeline / Features / Volumes / Import /
// Database, plus Instance for an admin). The body itself carries no
// padding/scroll of its own — same as Library's .tab-body — so a section with
// its own nested sub-nav (Settings › Pipeline) can pin that nav above its own
// scrolling body instead of scrolling under this one. Plain sections (Volumes,
// Import, Instance) own their padded scroll area directly. Reached from the
// account popover in the rail — deliberately not a rail entry of its own, so
// the rail stays about the work (Library, Sift, search, gear) and
// configuration lives one level down.
export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // The tab bar hides the admin-only Instance entry, so it needs the role on
  // the server — reading the identity the request guard already injected
  // (src/proxy.ts) rather than making the nav fetch /api/auth/me for itself.
  const me = identityFromHeaders(await headers());
  const isAdmin = me?.role === "admin";

  return (
    <div className="app-shell">
      <PageHeader title="Settings" tabs={<SettingsNav isAdmin={isAdmin} />} />
      <div className="tab-body">{children}</div>
    </div>
  );
}
