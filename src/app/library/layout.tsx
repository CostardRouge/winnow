import { headers } from "next/headers";
import type { ReactNode } from "react";
import { identityFromHeaders } from "@/lib/auth";
import PageHeader from "../PageHeader";
import StatsStrip from "../StatsStrip";
import LibraryNav from "./LibraryNav";

// Library chrome shared by every tab/view under /library: one header band
// (title, section tabs, the compact stats strip at its end — cf. PageHeader).
// The full pipeline control panel lives on its own /settings/pipeline page.
//
// A server layout so the tab bar knows the role without a fetch of its own:
// the admin-only Duplicates tab reads the identity the request guard already
// injected (src/proxy.ts), the way the Settings layout hides Instance.
export default async function LibraryLayout({ children }: { children: ReactNode }) {
  const me = identityFromHeaders(await headers());

  return (
    <div className="app-shell">
      <PageHeader
        title="Library"
        tabs={<LibraryNav isAdmin={me?.role === "admin"} />}
        trailing={<StatsStrip />}
      />

      <div className="tab-body">{children}</div>
    </div>
  );
}
