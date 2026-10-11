"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import PageHeader from "../PageHeader";
import StatsStrip from "../StatsStrip";

// Library chrome shared by every tab/view under /library: one header band
// (title, section tabs, the compact stats strip at its end — cf. PageHeader).
// The tabs and the active view are real URL segments:
//   /library/incoming/{sessions|grid|map}   ·   /library/gallery   ·   /library/exports
// so each pane is shareable and reload-safe. The full pipeline control panel
// lives on its own /settings/pipeline page.

const TABS: { id: string; label: string; href: string; match: (p: string) => boolean }[] = [
  {
    id: "incoming",
    label: "Incoming",
    href: "/library/incoming/sessions",
    match: (p) => p.startsWith("/library/incoming"),
  },
  {
    id: "gallery",
    label: "Gallery",
    href: "/library/gallery",
    match: (p) => p.startsWith("/library/gallery"),
  },
  {
    id: "exports",
    label: "Exports",
    href: "/library/exports",
    match: (p) => p.startsWith("/library/exports"),
  },
  {
    id: "trash",
    label: "Trash",
    href: "/library/trash",
    match: (p) => p.startsWith("/library/trash"),
  },
];

export default function LibraryLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "";

  return (
    <div className="app-shell">
      <PageHeader
        title="Library"
        tabs={
          <nav className="tabs" aria-label="Library sections">
            {TABS.map((t) => (
              <Link
                key={t.id}
                href={t.href}
                className={`tab${t.match(pathname) ? " active" : ""}`}
                aria-current={t.match(pathname) ? "page" : undefined}
              >
                {t.label}
              </Link>
            ))}
          </nav>
        }
        trailing={<StatsStrip />}
      />

      <div className="tab-body">{children}</div>
    </div>
  );
}
