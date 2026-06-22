"use client";

// Live scan (index) queue: the folders currently being indexed or waiting their
// turn. Each row is a root scan job; you can pull a stuck/unwanted one out of the
// queue (active jobs can't be removed mid-flight).
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchJson } from "@/lib/fetchJson";
import { EmptyState, Icons } from "../../ui";
import PullToRefresh from "../../PullToRefresh";

type ScanJob = {
  job_id: string;
  state: string;
  priority: number | null;
  attempts: number;
  timestamp: number | null;
  failed_reason: string | null;
  root_id: number | null;
  path: string | null;
  kind: string | null;
};

export default function ScanningPage() {
  const [items, setItems] = useState<ScanJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const busyRef = useRef<string | null>(null);
  busyRef.current = busy;

  const load = useCallback(async () => {
    try {
      const d = await fetchJson<{ items: ScanJob[] }>(
        "/api/pipeline/queue?name=scan",
      );
      setItems(d.items);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => {
      if (busyRef.current == null) load();
    }, 5000);
    return () => clearInterval(t);
  }, [load]);

  const remove = useCallback(
    async (jobId: string) => {
      if (busy) return;
      setBusy(jobId);
      setMsg("");
      try {
        const r = await fetch("/api/pipeline/queue/remove", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "scan", jobId }),
        });
        const d = await r.json();
        if (r.ok && d.removed) {
          setItems((prev) => prev.filter((j) => j.job_id !== jobId));
          setMsg("Removed from the scan queue.");
        } else {
          setMsg(`Couldn’t remove: ${d.reason ?? "unknown"}`);
        }
      } finally {
        setBusy(null);
      }
    },
    [busy],
  );

  return (
    <PullToRefresh className="pl-section" onRefresh={load}>
      <div className="filterbar">
        <span className="hint">
          Folders currently being indexed or waiting in the scan queue. Remove one
          to pull it out (active scans can’t be removed mid-flight).
        </span>
        <span className="spacer" />
        <button className="btn btn-sm" onClick={load} disabled={loading}>
          Refresh
        </button>
      </div>

      {error && (
        <div className="error-box">
          <span>Couldn’t load the scan queue: {error}</span>
          <button className="btn" onClick={load}>
            Retry
          </button>
        </div>
      )}
      {msg && <p className="hint">{msg}</p>}

      {loading ? (
        <div className="spinner">Loading…</div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={Icons.pipeline}
          title="Scan queue is empty"
          hint="No folders are being indexed right now."
        />
      ) : (
        <div className="pl-list">
          {items.map((j) => (
            <div key={j.job_id} className="pl-row">
              <div className="pl-main">
                <div className="pl-name">
                  {j.path ?? `root #${j.root_id ?? "?"}`}
                  <span className={`pill${j.state === "failed" ? " error" : ""}`}>
                    {j.state}
                  </span>
                  {j.priority != null && j.priority <= 1 && (
                    <span className="pill picks">priority</span>
                  )}
                  {j.kind && <span className="pill">{j.kind}</span>}
                </div>
                {j.failed_reason && <div className="pl-err">{j.failed_reason}</div>}
                <div className="pl-meta">
                  job #{j.job_id}
                  {j.attempts ? ` · ${j.attempts} attempt(s)` : ""}
                </div>
              </div>
              <div className="pl-actions">
                <button
                  className="btn btn-sm btn-reject"
                  onClick={() => remove(j.job_id)}
                  disabled={busy != null || j.state === "active"}
                  title={
                    j.state === "active"
                      ? "Can’t remove a scan that is running"
                      : "Remove this folder from the scan queue"
                  }
                >
                  {busy === j.job_id ? "…" : "Remove"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </PullToRefresh>
  );
}
