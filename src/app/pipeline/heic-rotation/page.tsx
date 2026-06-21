"use client";

// Pipeline "HEIC rotation" maintenance page. The scan is a tracked background
// job (BullMQ, run by the worker): this page enqueues it, polls its live
// progress, and rebuilds its state after a navigation/reload from the current or
// last job. Once done it lists the double-rotated files (with their current,
// wrong thumbnail) and re-queues them for regeneration — per file or all at once.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchJson } from "@/lib/fetchJson";
import { Icons, LazyImage } from "../../ui";

type Item = {
  id: number;
  filename: string;
  abs_path: string;
  ext: string;
  orientation: number;
};

type Result = {
  scanned: number;
  missing: number;
  ok: number;
  affectedCount: number;
  items: Item[];
  itemsCapped: boolean;
  affectedIds: number[];
};

type Status = {
  id: string | null;
  state: string; // none | waiting | prioritized | delayed | active | completed | failed
  progress: { processed: number; total: number } | null;
  result: Result | null;
  failedReason: string | null;
  startedAt: number | null;
  finishedAt: number | null;
};

// EXIF orientation → human angle, for the per-row badge.
const ANGLE: Record<number, string> = { 3: "180°", 6: "90°", 8: "270°" };

const STATE_LABEL: Record<string, string> = {
  waiting: "Queued",
  prioritized: "Queued",
  delayed: "Queued",
  active: "Scanning",
  completed: "Done",
  failed: "Failed",
};

export default function HeicRotationPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [msg, setMsg] = useState<string>("");
  // Key of the in-flight fix ("all" or "one:<id>") + ids already re-queued.
  const [busy, setBusy] = useState<string | null>(null);
  const [fixed, setFixed] = useState<Set<number>>(new Set());

  const ACTIVE = useMemo(
    () => new Set(["waiting", "prioritized", "delayed", "active"]),
    [],
  );
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Self-rescheduling poll: keeps ticking while a scan is in flight, stops once
  // it reaches a terminal state (the result is then stable).
  const poll = useCallback(async () => {
    try {
      const s = await fetchJson<Status>("/api/pipeline/heic-rotation");
      setStatus(s);
      setError(null);
      if (ACTIVE.has(s.state)) pollRef.current = setTimeout(poll, 1500);
    } catch (e) {
      setError((e as Error).message);
      pollRef.current = setTimeout(poll, 3000);
    }
  }, [ACTIVE]);

  useEffect(() => {
    poll();
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [poll]);

  const startScan = useCallback(async () => {
    setStarting(true);
    setMsg("");
    setError(null);
    try {
      const r = await fetch("/api/pipeline/heic-rotation", { method: "POST" });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setError(d.error ?? `HTTP ${r.status}`);
        return;
      }
      setFixed(new Set());
      if (pollRef.current) clearTimeout(pollRef.current);
      await poll();
    } finally {
      setStarting(false);
    }
  }, [poll]);

  const fix = useCallback(
    async (ids: number[], key: string) => {
      if (!ids.length || busy) return;
      setBusy(key);
      setMsg("");
      try {
        const r = await fetch("/api/assets/regenerate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids }),
        });
        const d = await r.json();
        if (!r.ok) {
          setMsg(`Error: ${d.error ?? "unknown"}`);
        } else {
          setFixed((prev) => {
            const next = new Set(prev);
            for (const id of ids) next.add(id);
            return next;
          });
          setMsg(
            `Re-queued ${d.queued ?? ids.length} asset(s) for regeneration — track them under Pending. Re-scan once the worker has rebuilt them to confirm.`,
          );
        }
      } catch (e) {
        setMsg(`Error: ${(e as Error).message}`);
      } finally {
        setBusy(null);
      }
    },
    [busy],
  );

  const state = status?.state ?? "none";
  const scanning = ACTIVE.has(state);
  const result = state === "completed" ? status?.result : null;
  const progress = status?.progress;
  const pct =
    progress && progress.total > 0
      ? Math.round((progress.processed / progress.total) * 100)
      : 0;

  const pendingIds = (result?.affectedIds ?? []).filter((id) => !fixed.has(id));
  const allFixed =
    result != null && result.affectedCount > 0 && pendingIds.length === 0;

  return (
    <section className="pl-section">
      <div className="filterbar">
        <span className="hint">
          Finds HEIC/HEIF whose thumbnail/proxy was rotated twice (the original
          stores its orientation in both the HEIF container and EXIF). Runs as a
          background job — you can leave this page and come back.
        </span>
        <span className="spacer" />
        {state !== "none" && STATE_LABEL[state] && (
          <span
            className={`pill${
              state === "failed"
                ? " error"
                : state === "completed"
                  ? " ready"
                  : " pending"
            }`}
          >
            {STATE_LABEL[state]}
            {status?.id ? ` · #${status.id}` : ""}
          </span>
        )}
        <button className="btn" onClick={startScan} disabled={scanning || starting}>
          {starting
            ? "Starting…"
            : scanning
              ? "Scanning…"
              : result
                ? "Re-scan"
                : "Scan now"}
        </button>
      </div>

      {error && (
        <div className="error-box">
          <span>{error}</span>
          <button className="btn" onClick={poll}>
            Retry
          </button>
        </div>
      )}
      {state === "failed" && status?.failedReason && (
        <div className="error-box">
          <span>Scan failed: {status.failedReason}</span>
          <button className="btn" onClick={startScan}>
            Run again
          </button>
        </div>
      )}
      {msg && <p className="hint">{msg}</p>}

      {scanning && (
        <div className="session-progress" style={{ margin: "12px 0" }}>
          <div className="session-progress-track">
            <div
              className="session-progress-fill"
              style={{
                width: `${pct}%`,
                background: "var(--color-accent)",
              }}
            />
          </div>
          <span className="session-progress-label">
            {progress
              ? `${progress.processed.toLocaleString()} / ${progress.total.toLocaleString()} (${pct}%)`
              : state === "active"
                ? "Starting…"
                : "Queued — waiting for the worker…"}
          </span>
        </div>
      )}

      {result && (
        <>
          <div className="filterbar" style={{ marginTop: 8, marginBottom: 6 }}>
            <span className="pill total">{result.scanned} scanned</span>
            <span
              className={`pill${result.affectedCount ? " error" : " ready"}`}
            >
              {result.affectedCount} affected
            </span>
            <span className="pill ready">{result.ok} OK</span>
            {result.missing > 0 && (
              <span className="pill pending">{result.missing} unreachable</span>
            )}
            <span className="spacer" />
            {result.affectedCount > 0 && (
              <button
                className="btn"
                onClick={() => fix(pendingIds, "all")}
                disabled={busy !== null || allFixed}
              >
                {Icons.regenerate}
                <span>
                  {busy === "all"
                    ? "…"
                    : allFixed
                      ? "All re-queued"
                      : `Fix all (${pendingIds.length})`}
                </span>
              </button>
            )}
          </div>

          {result.affectedCount === 0 ? (
            <div className="empty" style={{ padding: 16 }}>
              No double-rotated HEIC derivatives. 🎉
            </div>
          ) : (
            <>
              <p className="hint" style={{ marginTop: 0 }}>
                Thumbnails below are the current (wrong) derivatives — fixing
                re-queues generation with the corrected orientation handling.
              </p>
              <div className="fail-list">
                {result.items.map((it) => {
                  const done = fixed.has(it.id);
                  const oneKey = `one:${it.id}`;
                  return (
                    <div className="fail-row" key={it.id}>
                      <div className="fail-head">
                        <div className="pl-thumb" aria-hidden>
                          <LazyImage src={`/api/assets/${it.id}/thumb`} alt="" />
                        </div>
                        <strong className="fail-title">
                          #{it.id} · {it.filename}
                        </strong>
                        <span className="pill">
                          {it.ext} ·{" "}
                          {ANGLE[it.orientation] ?? `orient ${it.orientation}`}
                        </span>
                        <span className="spacer" />
                        <a
                          className="btn btn-sm btn-icon"
                          href={`/api/assets/${it.id}/download`}
                          download
                          title="Download the original file"
                          aria-label="Download the original file"
                        >
                          {Icons.download}
                        </a>
                        <button
                          className="btn btn-sm"
                          onClick={() => fix([it.id], oneKey)}
                          disabled={busy !== null || done}
                        >
                          {busy === oneKey ? "…" : done ? "Queued ✓" : "Fix"}
                        </button>
                      </div>
                      <div className="fail-path">{it.abs_path}</div>
                    </div>
                  );
                })}
              </div>
              {result.itemsCapped && (
                <p className="hint">
                  Showing the first {result.items.length} of{" "}
                  {result.affectedCount}. “Fix all” re-queues every affected
                  asset.
                </p>
              )}
            </>
          )}
        </>
      )}

      {state === "none" && !scanning && !error && (
        <div className="empty" style={{ padding: 16 }}>
          Run a scan to check your HEIC/HEIF derivatives for double rotation.
        </div>
      )}
    </section>
  );
}
