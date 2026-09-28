"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import PageHeader from "../PageHeader";

// Admin-only (the request guard redirects everyone else from /users/*). Two
// tabs, both about who may reach the library: the people (accounts, their
// roles, their invite links) and the keys a client app holds on one person's
// behalf (app tokens — for Atelier on a phone, where the session cookie cannot
// follow). Real URL segments, like /library's tabs, so each is reload-safe.

const TABS: { label: string; href: string; match: (p: string) => boolean }[] = [
  { label: "Accounts", href: "/users", match: (p) => p === "/users" },
  {
    label: "App tokens",
    href: "/users/tokens",
    match: (p) => p.startsWith("/users/tokens"),
  },
];

export default function UsersLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "";
  return (
    <div className="app-shell">
      <PageHeader
        title="Users"
        tabs={
          <nav className="tabs" aria-label="Users sections">
            {TABS.map((t) => (
              <Link
                key={t.href}
                href={t.href}
                className={`tab${t.match(pathname) ? " active" : ""}`}
                aria-current={t.match(pathname) ? "page" : undefined}
              >
                {t.label}
              </Link>
            ))}
          </nav>
        }
      />
      <div className="pipeline-body">{children}</div>
    </div>
  );
}
