"use client";

// Compact pipeline counters for the Library header — sits on the same row as
// the Incoming / Final / Exports tabs. At every width it's a single summary
// chip ("88K media ▾") that opens the full value+label breakdown in a small
// popover, so the header stays tight on desktop as well as on phones. Tapping a
// counter jumps to its dedicated /pipeline triage page.
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useStats, active, totalFailures } from "./useStats";

// Compact notation for the mobile summary chip so a six-figure library (88,035)
// reads as "88K" and never forces the header to wrap onto a second row. The full
// figure still shows in the desktop chip row and the popover detail.
const compact = (n: number) =>
  new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);

export default function StatsStrip() {
  const { stats } = useStats();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // Tap outside the open popover (mobile) dismisses it.
  useEffect(() => {
    if (!open) return;
    function onDown(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const a = stats?.assets;
  const paused = stats?.paused ?? false;
  const fails = totalFailures(stats);

  const chips: {
    key: string;
    label: string;
    value: number;
    tone?: "ok" | "warn" | "bad";
    href: string;
  }[] = [
    { key: "media", label: "Media", value: a?.total ?? 0, href: "/pipeline/media" },
    {
      key: "scan",
      label: paused ? "Paused" : "Scanning",
      value: active(stats?.queues?.scan),
      tone: paused ? "warn" : undefined,
      href: "/pipeline/scanning",
    },
    {
      key: "analyzed",
      label: "Analyzed",
      value: a?.analyzed ?? 0,
      tone: "ok",
      href: "/pipeline/analyzed",
    },
    {
      key: "pending",
      label: "Pending",
      value: a?.pending ?? 0,
      tone: "warn",
      href: "/pipeline/pending",
    },
  ];
  if (fails > 0) {
    chips.push({
      key: "fail",
      label: "Failures",
      value: fails,
      tone: "bad",
      href: "/pipeline/failures",
    });
  }

  return (
    <div className={`stats-strip${open ? " open" : ""}`} ref={ref}>
      {/* Mobile-only summary that toggles the detail popover. */}
      <button
        type="button"
        className="stats-summary"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Pipeline counters"
      >
        <span className="stats-summary-value">{compact(a?.total ?? 0)}</span>
        <span className="stats-summary-label">media</span>
        {fails > 0 && <span className="stats-summary-dot" aria-hidden />}
        <span className="stats-caret" aria-hidden>
          ▾
        </span>
      </button>

      <div className="stats-chips" role="group" aria-label="Pipeline counters">
        {chips.map((c) => (
          <Link
            key={c.key}
            href={c.href}
            className={`stat-chip${c.tone ? ` ${c.tone}` : ""}`}
            onClick={() => setOpen(false)}
            title={c.label}
          >
            <span className="stat-chip-value">{c.value.toLocaleString()}</span>
            <span className="stat-chip-label">{c.label}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
