"use client";

// Pipeline control surface — the detailed counters bento (media / scan /
// analyzed / pending / failures) plus pause/resume of the scan and the hourly
// rate sliders. Lives on the dedicated /pipeline page; the Library header only
// carries the compact StatsStrip. Auto-refreshes every 5 s via /api/stats.
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { active, totalFailures, useStats } from "./useStats";
import PullToRefresh from "./PullToRefresh";

const RATE_MAX = 3000;
const RATE_STEP = 50;

function rateLabel(v: number): string {
  return v <= 0 ? "Unlimited" : `${v.toLocaleString()}/h`;
}

export default function ControlPanel() {
  const { stats, reload } = useStats();
  const [scanRate, setScanRate] = useState(0);
  const [analyzeRate, setAnalyzeRate] = useState(0);
  const [mlRate, setMlRate] = useState(0);
  const [busy, setBusy] = useState(false);
  // While dragging a slider, we don't let polling overwrite its value.
  const dragging = useRef({ scan: false, analyze: false, ml: false });
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Mirror the persisted rates into the sliders, but never clobber a value the
  // user is actively dragging.
  useEffect(() => {
    if (!stats) return;
    if (!dragging.current.scan) setScanRate(stats.settings.scanPerHour);
    if (!dragging.current.analyze) setAnalyzeRate(stats.settings.analyzePerHour);
    if (!dragging.current.ml) setMlRate(stats.settings.mlPerHour ?? 0);
  }, [stats]);

  async function togglePause() {
    if (!stats) return;
    setBusy(true);
    try {
      await fetch("/api/scan/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: stats.paused ? "resume" : "pause" }),
      });
      await reload();
    } finally {
      setBusy(false);
    }
  }

  function commit(patch: {
    scanPerHour?: number;
    analyzePerHour?: number;
    mlPerHour?: number;
  }) {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }).catch(() => {});
    }, 350);
  }

  const paused = stats?.paused ?? false;
  const a = stats?.assets;
  const totalFail = totalFailures(stats);

  return (
    <PullToRefresh className="control" onRefresh={reload}>
      <div className="statbar">
        <Link href="/pipeline/media" className="stat-link">
          <Stat
            label="Media"
            value={a?.total}
            sub={`${a?.photos ?? 0} photos · ${a?.videos ?? 0} videos →`}
          />
        </Link>
        <Link href="/pipeline/scanning" className="stat-link">
          <Stat
            label="Scanning"
            value={active(stats?.queues?.scan)}
            sub={paused ? "paused →" : "folders in queue →"}
            tone={paused ? "warn" : undefined}
          />
        </Link>
        <Link href="/pipeline/analyzed" className="stat-link">
          <Stat label="Analyzed" value={a?.analyzed} sub="derivatives ready →" tone="ok" />
        </Link>
        <Link href="/pipeline/pending" className="stat-link">
          <Stat
            label="Pending"
            value={a?.pending}
            sub={`+ ${active(stats?.queues?.analyze)} in analyze queue →`}
            tone="warn"
          />
        </Link>
        {stats?.mlEnabled && (
          <Link
            href="/gallery?has_faces=1"
            className="stat-link"
            title="Faces & text detected off the derivatives — click to browse media with faces"
          >
            <Stat
              label="Faces & text"
              value={a?.ml_ready}
              sub={`${(a?.ml_pending ?? 0).toLocaleString()} to analyze →`}
              tone="accent"
            />
          </Link>
        )}
        <Link href="/pipeline/failures" className="stat-link">
          <Stat
            label="Failures"
            value={totalFail}
            sub="scan · analyze · import →"
            tone="bad"
          />
        </Link>
      </div>

      <div className="control-row">
        <button
          className={`btn ${paused ? "btn-primary" : "btn-reject"}`}
          onClick={togglePause}
          disabled={busy || !stats}
          title="Suspend or resume scanning and analysis"
        >
          {busy ? "…" : paused ? "▶ Resume scan" : "⏸ Pause scan"}
        </button>

        <div className="slider">
          <label>
            Scan rate <span className="hint">{rateLabel(scanRate)}</span>
          </label>
          <input
            type="range"
            min={0}
            max={RATE_MAX}
            step={RATE_STEP}
            value={scanRate}
            onPointerDown={() => (dragging.current.scan = true)}
            onPointerUp={() => (dragging.current.scan = false)}
            onChange={(e) => {
              const v = Number(e.target.value);
              setScanRate(v);
              commit({ scanPerHour: v });
            }}
          />
        </div>

        <div className="slider">
          <label>
            Analyze rate <span className="hint">{rateLabel(analyzeRate)}</span>
          </label>
          <input
            type="range"
            min={0}
            max={RATE_MAX}
            step={RATE_STEP}
            value={analyzeRate}
            onPointerDown={() => (dragging.current.analyze = true)}
            onPointerUp={() => (dragging.current.analyze = false)}
            onChange={(e) => {
              const v = Number(e.target.value);
              setAnalyzeRate(v);
              commit({ analyzePerHour: v });
            }}
          />
        </div>

        {stats?.mlEnabled && (
          <div className="slider">
            <label>
              Faces/OCR rate <span className="hint">{rateLabel(mlRate)}</span>
            </label>
            <input
              type="range"
              min={0}
              max={RATE_MAX}
              step={RATE_STEP}
              value={mlRate}
              onPointerDown={() => (dragging.current.ml = true)}
              onPointerUp={() => (dragging.current.ml = false)}
              onChange={(e) => {
                const v = Number(e.target.value);
                setMlRate(v);
                commit({ mlPerHour: v });
              }}
            />
          </div>
        )}
      </div>
      <div className="hint control-note">
        Photos/hour, 0 = unlimited. Incoming &amp; inbox folders are scanned and
        analyzed first.
      </div>
    </PullToRefresh>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: number | undefined;
  sub?: string;
  tone?: "ok" | "warn" | "bad" | "accent";
}) {
  return (
    <div className={`stat${tone ? ` ${tone}` : ""}`}>
      <div className="stat-value">{(value ?? 0).toLocaleString()}</div>
      <div className="stat-label">{label}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}
