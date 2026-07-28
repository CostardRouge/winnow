"use client";

// Sub-route tab bar for the Settings section, using the same segmented-control
// .tabs/.tab styling as the Library section's tab bar so the two read as one
// family. Text-only tabs: these three panes have no meaningful count to badge.
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS: { href: string; label: string }[] = [
  { href: "/settings/pipeline", label: "Pipeline" },
  { href: "/settings/volumes", label: "Volumes" },
  { href: "/settings/import", label: "Import" },
];

export default function SettingsNav() {
  const pathname = usePathname() ?? "/settings";

  return (
    <nav className="tabs" aria-label="Settings sections">
      {TABS.map((t) => {
        const isActive = pathname === t.href;
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`tab${isActive ? " active" : ""}`}
            aria-current={isActive ? "page" : undefined}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
