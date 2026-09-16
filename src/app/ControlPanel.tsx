"use client";

// Pipeline control surface — the detailed counters bento (media / scan /
// analyzed / pending / failures) plus pause/resume of the scan and the hourly
// rate sliders. Lives on the Settings › Pipeline page; the Library header only
// carries the compact StatsStrip. Auto-refreshes every 5 s via /api/stats.
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { active, totalFailures, useStats } from "./useStats";
import PullToRefresh from "./PullToRefresh";
import { OptionPicker, type PickerOption } from "./OptionPicker";
import { Spinner } from "./ui";

const RATE_MAX = 3000;
const RATE_STEP = 50;
// Periodic re-scan slider: up to 24 h between automatic incremental scans.
const RESCAN_MAX = 1440;
const RESCAN_STEP = 15;
// Reverse geocoding is paced against someone else's server, so its ceiling is
// higher than the local stages': the public Nominatim instance asks for ~1
// call/second (3600/h, the default) and a private one can take far more. The
// slider's real max is raised to fit a stored value above this, so a rate set
// outside the UI is shown as it is rather than clamped into a lie.
const GEOCODE_RATE_MAX = 10_000;
const GEOCODE_RATE_STEP = 100;

// Reverse-geocoding cell size. `precision_m` is part of the `places` primary key
// (cell_lat, cell_lon, precision_m), so changing it never re-tags what is
// already geocoded — it starts a fresh set of cells, and the first asset to land
// in each one costs a real lookup. Bigger cells = fewer calls, coarser names.
const PRECISION_CHOICES: { m: number; label: string; hint: string }[] = [
  {
    m: 100,
    label: "100 m",
    hint: "A street corner. The finest names, and nearly every new spot is its own lookup.",
  },
  {
    m: 500,
    label: "500 m",
    hint: "A neighbourhood — a district in a city, a hamlet in the country.",
  },
  { m: 1000, label: "1 km", hint: "A village, or one district of a town." },
  {
    m: 5000,
    label: "5 km",
    hint: "A town and what surrounds it. The default, and comfortable against the public Nominatim instance.",
  },
  {
    m: 25_000,
    label: "25 km",
    hint: "A region. By far the fewest lookups, and a day out reads as one place.",
  },
];

function rateLabel(v: number): string {
  return v <= 0 ? "Unlimited" : `${v.toLocaleString()}/h`;
}

function metresLabel(m: number): string {
  return m >= 1000 ? `${(m / 1000).toLocaleString()} km` : `${m} m`;
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
  const [geocodeRate, setGeocodeRate] = useState(0);
  const [precision, setPrecision] = useState(0);
  const [busy, setBusy] = useState(false);
  // Drone-telemetry backfill (one-click counterpart to `npm run srt-backfill`).
  const [srtBusy, setSrtBusy] = useState(false);
  const [srtMsg, setSrtMsg] = useState<string | null>(null);
  // ML/search-index backfill (one-click counterpart to `npm run ml-backfill`).
  const [mlBusy, setMlBusy] = useState(false);
  const [mlMsg, setMlMsg] = useState<string | null>(null);
  // While dragging a slider, we don't let polling overwrite its value.
  const dragging = useRef({
    scan: false,
    analyze: false,
    ml: false,
    rescan: false,
    geocode: false,
  });
  // The precision picker has no pointerdown/up pair to hold the poll off the
  // way a slider does, so the chosen value is held here until a tick confirms
  // the server agrees — otherwise a poll landing between the click and the
  // debounced PATCH flips the control back to the old size for a beat.
  const pendingPrecision = useRef<number | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Mirror the persisted rates into the sliders, but never clobber a value the
  // user is actively dragging.
  useEffect(() => {
    if (!stats) return;
    if (!dragging.current.scan) setScanRate(stats.settings.scanPerHour);
    if (!dragging.current.analyze) setAnalyzeRate(stats.settings.analyzePerHour);
    if (!dragging.current.ml) setMlRate(stats.settings.mlPerHour ?? 0);
    if (!dragging.current.rescan) setRescan(stats.settings.rescanMinutes ?? 0);
    if (!dragging.current.geocode)
      setGeocodeRate(stats.settings.geocodePerHour ?? 0);
    const servedPrecision = stats.settings.geocodePrecisionM ?? 0;
    if (
      pendingPrecision.current === null ||
      pendingPrecision.current === servedPrecision
    ) {
      pendingPrecision.current = null;
      setPrecision(servedPrecision);
    }
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
    geocodePerHour?: number;
    geocodePrecisionM?: number;
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

  // The API accepts 1 m – 500 km, so a value outside this list is possible and
  // must be named rather than snapped to the nearest preset. This is not
  // cosmetic: OptionPicker resolves an unmatched value to `options[0]`, so
  // without this entry a stored 3 km would sit there reading "100 m" — the
  // picker would state a setting the server does not hold.
  const precisionOptions: PickerOption<string>[] = PRECISION_CHOICES.map((c) => ({
    key: String(c.m),
    label: c.label,
    hint: c.hint,
  }));
  if (!PRECISION_CHOICES.some((c) => c.m === precision))
    precisionOptions.unshift({
      key: String(precision),
      label: precision > 0 ? metresLabel(precision) : "Not set",
      hint: "Set outside this list — kept as it is until you choose another size.",
    });

  return (
    <PullToRefresh className="control" onRefresh={reload}>
      <div className="statbar">
        <Link href="/settings/pipeline/media" className="stat-link">
          <Stat
            label="Media"
            value={a?.total}
            sub={`${a?.photos ?? 0} photos · ${a?.videos ?? 0} videos →`}
          />
        </Link>
        <Link href="/settings/pipeline/scanning" className="stat-link">
          <Stat
            label="Scanning"
            value={active(stats?.queues?.scan)}
            sub={paused ? "paused →" : "folders in queue →"}
            tone={paused ? "warn" : undefined}
          />
        </Link>
        <Link href="/settings/pipeline/media?status=ready&sort=processed" className="stat-link">
          <Stat label="Analyzed" value={a?.analyzed} sub="derivatives ready →" tone="ok" />
        </Link>
        <Link href="/settings/pipeline/pending" className="stat-link">
          <Stat
            label="Pending"
            value={a?.pending}
            sub={`+ ${active(stats?.queues?.analyze)} in analyze queue →`}
            tone="warn"
          />
        </Link>
        {stats?.mlEnabled && (
          <Link
            href="/settings/pipeline/faces"
            className="stat-link"
            title="Faces & text detected off the derivatives — click to triage the ML stage (what's analyzed, pending, failed)"
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
            href="/settings/pipeline/search"
            className="stat-link"
            title="Media with a CLIP embedding — the pool semantic search ranks. Click to see what's missing from the index and fill it."
          >
            <Stat
              label="Search index"
              value={stats.clip.indexed}
              sub={`of ${stats.clip.library.toLocaleString()} media →`}
              tone={stats.clip.indexed >= stats.clip.library ? "ok" : "warn"}
            />
          </Link>
        )}
        <Link href="/settings/pipeline/failures" className="stat-link">
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
          {busy ? <Spinner sm /> : paused ? "▶ Resume scan" : "⏸ Pause scan"}
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

      {/* Reverse geocoding: both knobs have lived in app_settings since the
          feature shipped and neither had a control — they were reachable only
          by PATCHing /api/settings by hand. Grouped in one row because the two
          trade against each other: a smaller cell means finer names AND more
          calls, which is what the rate is there to bound. */}
      {stats?.geocodeEnabled && (
        <>
          <div className="control-row">
            <div className="slider">
              <label>
                Geocode rate <span className="hint">{rateLabel(geocodeRate)}</span>
              </label>
              <input
                type="range"
                min={0}
                max={Math.max(GEOCODE_RATE_MAX, geocodeRate)}
                step={GEOCODE_RATE_STEP}
                value={geocodeRate}
                onPointerDown={() => (dragging.current.geocode = true)}
                onPointerUp={() => (dragging.current.geocode = false)}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setGeocodeRate(v);
                  commit({ geocodePerHour: v });
                }}
              />
            </div>

            <div className="control-field">
              <label>
                Place precision{" "}
                <span className="hint">
                  {precision > 0 ? metresLabel(precision) : "—"}
                </span>
              </label>
              <OptionPicker
                options={precisionOptions}
                value={String(precision)}
                onChange={(key) => {
                  const m = Number(key);
                  pendingPrecision.current = m;
                  setPrecision(m);
                  commit({ geocodePrecisionM: m });
                }}
                ariaLabel="Reverse-geocoding cell size"
              />
            </div>
          </div>
          <div className="hint control-note">
            Calls/hour to the geocoder, 0 = unlimited — the public Nominatim
            instance asks for about one per second, which is what the 3,600
            default means. <strong>Place precision</strong> is the grid step that
            snaps nearby coordinates onto one shared cell, so everything in the
            same cell costs a single lookup and carries the same place name.
            Changing it does not re-tag anything already geocoded: it starts a
            fresh set of cells, so expect a burst of real lookups afterwards, and
            a coarser step is what keeps a long trip from spending a call per
            stop.
          </div>
        </>
      )}

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
