"use client";

// Sub-route tab bar for the Settings section, mirroring PipelineNav's shape (and
// reusing its .pipeline-tab styling) so the two sections read as one family.
// Text-only tabs: these three panes have no meaningful count to badge.
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
    <nav className="pipeline-tabs" aria-label="Settings sections">
      {TABS.map((t) => {
        const isActive = pathname === t.href;
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`pipeline-tab${isActive ? " active" : ""}`}
            aria-current={isActive ? "page" : undefined}
          >
            <span>{t.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
