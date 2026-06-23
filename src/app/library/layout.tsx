"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import StatsStrip from "../StatsStrip";

// Library chrome shared by every tab/view under /library. The tabs and the
// active view are now real URL segments:
//   /library/incoming/{sessions|grid|map}   ·   /library/gallery   ·   /library/exports
// so each pane is shareable and reload-safe. The compact stats strip rides the
// tabs row; the full pipeline control panel lives on its own /pipeline page.

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
      <div className="topbar">
        <h1>Library</h1>
        <span className="hint max-sm:hidden">media triage — NAS</span>
      </div>

      <div className="shell-head">
        <div className="shell-head-row">
          <div className="tabs">
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
          </div>
          <span className="spacer" />
          <StatsStrip />
        </div>
      </div>

      <div className="tab-body">{children}</div>
    </div>
  );
}
