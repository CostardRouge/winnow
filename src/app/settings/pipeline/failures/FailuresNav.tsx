"use client";

// Sub-route tab bar for the failure families. Each family is a real URL
// (/settings/pipeline/failures/analyze, /scan, …) so a specific list — say the
// deduplication triage — can be linked to directly. The per-family counts ride
// the shared /api/stats poll (stats.failures mirrors the /api/failures
// families), so the badges stay live without loading the full listings.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useStats, type Stats } from "../../../useStats";

const FAMILIES: {
  slug: string;
  label: string;
  count: (s: Stats | null) => number;
}[] = [
  { slug: "analyze", label: "Analyze", count: (s) => s?.failures?.derivative ?? 0 },
  { slug: "scan", label: "Scan", count: (s) => s?.failures?.scan ?? 0 },
  { slug: "import", label: "Import", count: (s) => s?.failures?.import ?? 0 },
  { slug: "ml", label: "Machine learning", count: (s) => s?.failures?.ml ?? 0 },
  {
    slug: "duplicates",
    label: "Deduplication",
    count: (s) => s?.failures?.duplicates ?? 0,
  },
  {
    slug: "missing",
    label: "Missing files",
    count: (s) => s?.failures?.missing ?? 0,
  },
];

export default function FailuresNav() {
  const pathname = usePathname() ?? "";
  const { stats } = useStats();

  return (
    <nav className="fail-tabs" aria-label="Failure families">
      {FAMILIES.map((f) => {
        const href = `/settings/pipeline/failures/${f.slug}`;
        const isActive = pathname === href;
        const count = f.count(stats);
        return (
          <Link
            key={f.slug}
            href={href}
            className={`fail-tab${isActive ? " active" : ""}${
              count > 0 ? " bad" : ""
            }`}
            aria-current={isActive ? "page" : undefined}
          >
            <span>{f.label}</span>
            <span className="fail-tab-count">{count.toLocaleString()}</span>
          </Link>
        );
      })}
    </nav>
  );
}
