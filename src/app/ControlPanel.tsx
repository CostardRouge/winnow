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
// Periodic re-scan slider: up to 24 h between automatic incremental scans.
const RESCAN_MAX = 1440;
const RESCAN_STEP = 15;

function rateLabel(v: number): string {
  return v <= 0 ? "Unlimited" : `${v.toLocaleString()}/h`;
}

function rescanLabel(v: number): string {
  if (v <= 0) return "Off";
  if (v < 60) return `every ${v} min`;
  const h = v / 60;
  return `every ${Number.isInteger(h) ? h : h.toFixed(1)} h`;
}

export default function ControlPanel() {
  const { stats, reload } = useStats();
  const [scanRate, setScanRate] = useState(0);
  const [analyzeRate, setAnalyzeRate] = useState(0);
  const [mlRate, setMlRate] = useState(0);
  const [rescan, setRescan] = useState(0);
  const [busy, setBusy] = useState(false);
  // Drone-telemetry backfill (one-click counterpart to `npm run srt-backfill`).
  const [srtBusy, setSrtBusy] = useState(false);
  const [srtMsg, setSrtMsg] = useState<string | null>(null);
  // ML/search-index backfill (one-click counterpart to `npm run ml-backfill`).
  const [mlBusy, setMlBusy] = useState(false);
  const [mlMsg, setMlMsg] = useState<string | null>(null);
  // While dragging a slider, we don't let polling overwrite its value.
  const dragging = useRef({ scan: false, analyze: false, ml: false, rescan: false });
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Mirror the persisted rates into the sliders, but never clobber a value the
  // user is actively dragging.
  useEffect(() => {
    if (!stats) return;
    if (!dragging.current.scan) setScanRate(stats.settings.scanPerHour);
    if (!dragging.current.analyze) setAnalyzeRate(stats.settings.analyzePerHour);
    if (!dragging.current.ml) setMlRate(stats.settings.mlPerHour ?? 0);
    if (!dragging.current.rescan) setRescan(stats.settings.rescanMinutes ?? 0);
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

  // Parse the DJI .SRT flight logs of already-indexed drone clips and backfill
  // their GPS from the telemetry. Runs on the server (inline); geocoding of the
  // located clips is offloaded to the geocode queue, so this returns a summary.
  async function runSrtBackfill() {
    setSrtBusy(true);
    setSrtMsg(null);
    try {
      const res = await fetch("/api/pipeline/srt-backfill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = (await res.json().catch(() => ({}))) as {
        scanned?: number;
        parsed?: number;
        located?: number;
        geocoded?: number;
        error?: string;
      };
      if (!res.ok) {
        setSrtMsg(body.error ?? "Backfill failed");
      } else if (!body.scanned) {
        setSrtMsg("No unparsed drone .SRT sidecars found.");
      } else {
        setSrtMsg(
          `Parsed ${body.parsed}/${body.scanned} · located ${body.located} clip(s) · queued ${body.geocoded} geocode job(s).`,
        );
        await reload();
      }
    } catch {
      setSrtMsg("Backfill failed");
    } finally {
      setSrtBusy(false);
    }
  }

  // Enqueue an ML job for every asset still missing an analysis or a CLIP
  // embedding (the gap that leaves semantic search returning the same few
  // images). Enqueue-only: the ml queue drains at the Faces/OCR rate.
  async function runMlBackfill() {
    setMlBusy(true);
    setMlMsg(null);
    try {
      const res = await fetch("/api/pipeline/ml-backfill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = (await res.json().catch(() => ({}))) as {
        queued?: number;
        error?: string;
      };
      if (!res.ok) {
        setMlMsg(body.error ?? "Backfill failed");
      } else if (!body.queued) {
        setMlMsg("Everything is already analyzed & indexed.");
      } else {
        setMlMsg(
          `Queued ${body.queued.toLocaleString()} job(s) — drains at the Faces/OCR rate.`,
        );
        await reload();
      }
    } catch {
      setMlMsg("Backfill failed");
    } finally {
      setMlBusy(false);
    }
  }

  function commit(patch: {
    scanPerHour?: number;
    analyzePerHour?: number;
    mlPerHour?: number;
    rescanMinutes?: number;
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
        <Link href="/pipeline/media?status=ready&sort=processed" className="stat-link">
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
        {stats?.clipEnabled && stats.clip && (
          <Link
            href="/search"
            className="stat-link"
            title="Media with a CLIP embedding — the pool semantic search ranks. Below the library total? Run “Index for search” below."
          >
            <Stat
              label="Search index"
              value={stats.clip.indexed}
              sub={`of ${stats.clip.library.toLocaleString()} media →`}
              tone={stats.clip.indexed >= stats.clip.library ? "ok" : "warn"}
            />
          </Link>
        )}
        <Link href="/pipeline/failures" className="stat-link">
          <Stat
            label="Failures"
            value={totalFail}
            sub="scan · analyze · import · dedup →"
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

        <div className="slider">
          <label>
            Rescan interval <span className="hint">{rescanLabel(rescan)}</span>
          </label>
          <input
            type="range"
            min={0}
            max={RESCAN_MAX}
            step={RESCAN_STEP}
            value={rescan}
            onPointerDown={() => (dragging.current.rescan = true)}
            onPointerUp={() => (dragging.current.rescan = false)}
            onChange={(e) => {
              const v = Number(e.target.value);
              setRescan(v);
              commit({ rescanMinutes: v });
            }}
          />
        </div>
      </div>
      <div className="hint control-note">
        Photos/hour, 0 = unlimited. Incoming &amp; inbox folders are scanned and
        analyzed first. The rescan interval re-walks the volumes automatically
        (incremental — unchanged files are only stat-ed) so new, changed and
        deleted files are noticed without a manual re-index; Off = only at
        worker startup, on import, or by hand.
      </div>

      <div className="control-row control-maintenance">
        <button
          className="btn"
          onClick={runSrtBackfill}
          disabled={srtBusy}
          title="Parse DJI drone .SRT flight logs and backfill each clip's GPS from the telemetry (idempotent)"
        >
          {srtBusy ? "Backfilling…" : "🛰 Backfill drone telemetry"}
        </button>
        {srtMsg && <span className="hint">{srtMsg}</span>}
      </div>
      <div className="hint control-note">
        Reads the DJI <code>.SRT</code> sidecars already indexed next to your
        drone clips, records their flight telemetry and gives clips without EXIF
        GPS a location from the flight log.
      </div>

      {stats?.mlEnabled && (
        <>
          <div className="control-row control-maintenance">
            <button
              className="btn"
              onClick={runMlBackfill}
              disabled={mlBusy}
              title="Queue ML analysis for every asset still missing faces/OCR or a search embedding (idempotent)"
            >
              {mlBusy ? "Queuing…" : "🔍 Index for search"}
            </button>
            {mlMsg && <span className="hint">{mlMsg}</span>}
          </div>
          <div className="hint control-note">
            Queues the ML analysis (faces, text, search embedding) for every
            media that doesn&apos;t have one yet — including media analyzed
            before semantic search was enabled, which otherwise never enter the
            search index. Idempotent; paced by the Faces/OCR rate slider.
          </div>
        </>
      )}
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
