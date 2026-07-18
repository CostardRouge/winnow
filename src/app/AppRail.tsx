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
    href: "/library",
    label: "Library",
    icon: Icons.library,
    match: (p) => p === "/" || p.startsWith("/library") || p.startsWith("/sessions"),
  },
  {
    href: "/sift",
    label: "Sift",
    icon: Icons.sift,
    match: (p) => p.startsWith("/sift"),
  },
  {
    href: "/search",
    label: "Search",
    icon: Icons.search,
    match: (p) => p.startsWith("/search"),
  },
  {
    href: "/import",
    label: "Import",
    icon: Icons.inbox,
    match: (p) => p.startsWith("/import"),
  },
  {
    href: "/volumes",
    label: "Volumes",
    icon: Icons.volumes,
    match: (p) => p.startsWith("/volumes"),
  },
  {
    href: "/pipeline",
    label: "Pipeline",
    icon: Icons.pipeline,
    // Failures now lives under /pipeline, so the rail entry covers it too.
    match: (p) => p.startsWith("/pipeline"),
  },
];

export default function AppRail() {
  const pathname = usePathname() ?? "/";

  return (
    <nav className="rail" aria-label="Primary">
      <Link href="/library" className="rail-brand" aria-label="Winnow — home">
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
