"use client";

// Sub-route tab bar for the Pipeline section. Each tab mirrors a counter from the
// overview bento and links to its dedicated triage page, with a live count badge
// fed by the shared /api/stats poll. "Failures" is always present (no longer
// conditional on there being errors).
import Link from "next/link";
import { usePathname } from "next/navigation";
import { active, totalFailures, useStats } from "../../useStats";

export default function PipelineNav() {
  const pathname = usePathname() ?? "/settings/pipeline";
  const { stats } = useStats();
  const a = stats?.assets;

  const tabs: {
    href: string;
    label: string;
    count?: number;
    tone?: "ok" | "warn" | "bad";
  }[] = [
    { href: "/settings/pipeline", label: "Overview" },
    { href: "/settings/pipeline/media", label: "Media", count: a?.total ?? 0 },
    {
      href: "/settings/pipeline/scanning",
      label: "Scanning",
      count: active(stats?.queues?.scan),
      tone: stats?.paused ? "warn" : undefined,
    },
    {
      href: "/settings/pipeline/pending",
      label: "Pending",
      count: a?.pending ?? 0,
      tone: "warn",
    },
    // The ML stages only exist when the feature is configured server-side —
    // same gating as the overview tiles (a stage that can never progress isn't
    // shown). The tabs appear once the first /api/stats poll lands.
    ...(stats?.mlEnabled
      ? [
          {
            href: "/settings/pipeline/faces",
            label: "Faces & text",
            count: a?.ml_pending ?? 0,
            tone: "warn" as const,
          },
        ]
      : []),
    ...(stats?.clipEnabled && stats.clip
      ? [
          {
            href: "/settings/pipeline/search",
            label: "Search index",
            count: Math.max(0, stats.clip.library - stats.clip.indexed),
            tone: "warn" as const,
          },
        ]
      : []),
    {
      href: "/settings/pipeline/failures",
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
