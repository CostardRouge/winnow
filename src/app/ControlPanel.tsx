"use client";

// Dashboard — strip of figures (media / scan / analyzed / pending)
// + pipeline control: pause/resume of the scan and hourly rates (sliders).
// Auto-refreshes every 5 s via /api/stats.
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { fetchJson } from "@/lib/fetchJson";

type QueueCounts = Record<string, number>;
type Stats = {
  assets: {
    total: number;
    photos: number;
    videos: number;
    analyzed: number;
    pending: number;
    errors: number;
    skipped: number;
    picks: number;
  };
  queues: {
    scan: QueueCounts;
    analyze: QueueCounts;
    import: QueueCounts;
    paused: boolean;
  } | null;
  paused: boolean;
  settings: { scanPerHour: number; analyzePerHour: number };
  failures?: { derivative: number; scan: number; import: number };
};

const RATE_MAX = 3000;
const RATE_STEP = 50;

// Active work in a queue = in progress + pending (prioritized included).
function active(c: QueueCounts | undefined): number {
  if (!c) return 0;
  return (c.active ?? 0) + (c.waiting ?? 0) + (c.prioritized ?? 0);
}

function rateLabel(v: number): string {
  return v <= 0 ? "Unlimited" : `${v.toLocaleString()}/h`;
}

export default function ControlPanel() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [scanRate, setScanRate] = useState(0);
  const [analyzeRate, setAnalyzeRate] = useState(0);
  const [busy, setBusy] = useState(false);
  // While dragging a slider, we don't let polling overwrite its value.
  const dragging = useRef({ scan: false, analyze: false });
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await fetchJson<Stats>("/api/stats");
      setStats(s);
      if (!dragging.current.scan) setScanRate(s.settings.scanPerHour);
      if (!dragging.current.analyze) setAnalyzeRate(s.settings.analyzePerHour);
    } catch {
      /* transient error: keep the current display */
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  async function togglePause() {
    if (!stats) return;
    setBusy(true);
    try {
      await fetch("/api/scan/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: stats.paused ? "resume" : "pause" }),
      });
      await load();
    } finally {
      setBusy(false);
    }
  }

  function commit(patch: { scanPerHour?: number; analyzePerHour?: number }) {
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
  const f = stats?.failures;
  const totalFail = (f?.derivative ?? 0) + (f?.scan ?? 0) + (f?.import ?? 0);

  return (
    <div className="control">
      <div className="statbar">
        <Stat label="Media" value={a?.total} sub={`${a?.photos ?? 0} photos · ${a?.videos ?? 0} videos`} />
        <Stat
          label="Scanning"
          value={active(stats?.queues?.scan)}
          sub={paused ? "paused" : "folders in queue"}
          tone={paused ? "warn" : undefined}
        />
        <Stat label="Analyzed" value={a?.analyzed} sub="derivatives ready" tone="ok" />
        <Stat
          label="Pending"
          value={a?.pending}
          sub={`+ ${active(stats?.queues?.analyze)} in analyze queue`}
          tone="warn"
        />
        {totalFail > 0 && (
          <Link href="/failures" className="stat-link">
            <Stat
              label="Failures"
              value={totalFail}
              sub="scan · analyze · import →"
              tone="bad"
            />
          </Link>
        )}
        <Stat label="Picks" value={a?.picks} sub="selected" tone="accent" />
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
      </div>
      <div className="hint control-note">
        Photos/hour, 0 = unlimited. Incoming &amp; inbox folders are scanned and
        analyzed first.
      </div>
    </div>
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
