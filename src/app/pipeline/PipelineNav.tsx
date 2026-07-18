"use client";

// Sub-route tab bar for the Pipeline section. Each tab mirrors a counter from the
// overview bento and links to its dedicated triage page, with a live count badge
// fed by the shared /api/stats poll. "Failures" is always present (no longer
// conditional on there being errors).
import Link from "next/link";
import { usePathname } from "next/navigation";
import { active, totalFailures, useStats } from "../useStats";

export default function PipelineNav() {
  const pathname = usePathname() ?? "/pipeline";
  const { stats } = useStats();
  const a = stats?.assets;

  const tabs: {
    href: string;
    label: string;
    count?: number;
    tone?: "ok" | "warn" | "bad";
  }[] = [
    { href: "/pipeline", label: "Overview" },
    { href: "/pipeline/media", label: "Media", count: a?.total ?? 0 },
    {
      href: "/pipeline/scanning",
      label: "Scanning",
      count: active(stats?.queues?.scan),
      tone: stats?.paused ? "warn" : undefined,
    },
    {
      href: "/pipeline/pending",
      label: "Pending",
      count: a?.pending ?? 0,
      tone: "warn",
    },
    {
      href: "/pipeline/failures",
      label: "Failures",
      count: totalFailures(stats),
      tone: "bad",
    },
  ];

  return (
    <nav className="pipeline-tabs" aria-label="Pipeline sections">
      {tabs.map((t) => {
        const isActive = pathname === t.href;
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`pipeline-tab${isActive ? " active" : ""}${
              t.tone ? ` ${t.tone}` : ""
            }`}
            aria-current={isActive ? "page" : undefined}
          >
            <span>{t.label}</span>
            {t.count != null && (
              <span className="pipeline-tab-count">
                {t.count.toLocaleString()}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
