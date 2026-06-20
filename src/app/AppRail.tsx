"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Brand, Icons } from "./ui";
import type { ReactNode } from "react";

// Persistent navigation rail: vertical on desktop (left edge), a bottom tab bar
// on phones. The single source of app navigation — pages no longer carry their
// own back-arrows. "Library" owns the home dashboard and every session drill-in.
type NavItem = {
  href: string;
  label: string;
  icon: ReactNode;
  match: (path: string) => boolean;
};

const NAV: NavItem[] = [
  {
    href: "/",
    label: "Library",
    icon: Icons.library,
    match: (p) => p === "/" || p.startsWith("/sessions"),
  },
  {
    href: "/gallery",
    label: "Gallery",
    icon: Icons.photos,
    match: (p) => p.startsWith("/gallery"),
  },
  {
    href: "/import",
    label: "Import",
    icon: Icons.inbox,
    match: (p) => p.startsWith("/import"),
  },
  {
    href: "/pipeline",
    label: "Pipeline",
    icon: Icons.pipeline,
    match: (p) => p.startsWith("/pipeline"),
  },
  {
    href: "/failures",
    label: "Failures",
    icon: Icons.alert,
    match: (p) => p.startsWith("/failures"),
  },
];

export default function AppRail() {
  const pathname = usePathname() ?? "/";

  return (
    <nav className="rail" aria-label="Primary">
      <Link href="/" className="rail-brand" aria-label="Winnow — home">
        <Brand compact />
      </Link>
      <div className="rail-nav">
        {NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`rail-link${item.match(pathname) ? " active" : ""}`}
            aria-current={item.match(pathname) ? "page" : undefined}
          >
            <span className="rail-ic" aria-hidden>
              {item.icon}
            </span>
            <span className="rail-label">{item.label}</span>
          </Link>
        ))}
      </div>
    </nav>
  );
}
