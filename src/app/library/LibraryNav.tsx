"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useStats } from "../useStats";

// The Library's section tabs. Every tab and view is a real URL segment:
//   /library/incoming/{sessions|grid|map} · /library/gallery · /library/exports
//   · /library/trash · /library/duplicates
// so each pane is shareable and reload-safe.
//
// Duplicates is shown to admins only: every action on that page is an admin
// write (/api/failures is an ADMIN_WRITE prefix, lib/authz.ts), so for anyone
// else it would be a tab of buttons that all answer 403. Its badge is the
// count of recorded copies still awaiting triage, from the shared stats poll.
const TABS: {
  id: string;
  label: string;
  href: string;
  adminOnly?: boolean;
  match: (p: string) => boolean;
}[] = [
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
  {
    id: "duplicates",
    label: "Duplicates",
    href: "/library/duplicates",
    adminOnly: true,
    match: (p) => p.startsWith("/library/duplicates"),
  },
];

export default function LibraryNav({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname() ?? "";
  const { stats } = useStats();
  const dupes = stats?.failures?.duplicates ?? 0;

  return (
    <nav className="tabs" aria-label="Library sections">
      {TABS.filter((t) => !t.adminOnly || isAdmin).map((t) => (
        <Link
          key={t.id}
          href={t.href}
          className={`tab${t.match(pathname) ? " active" : ""}`}
          aria-current={t.match(pathname) ? "page" : undefined}
        >
          {t.label}
          {t.id === "duplicates" && dupes > 0 && (
            <span className="tab-count">{dupes.toLocaleString()}</span>
          )}
        </Link>
      ))}
    </nav>
  );
}
