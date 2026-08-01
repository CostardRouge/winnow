"use client";

// ML (faces / OCR / CLIP) queue history — the "view the job" panel shared by the
// Faces & text and Search index pages. Lists every run of the ml queue (active,
// queued, completed, failed) enriched with the asset it points at and, once the
// run landed, what the analysis found (faces / text). Queued runs can be pulled
// out; failed runs show the reason.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchJson } from "@/lib/fetchJson";
import { EmptyState, Icons } from "../../ui";
import PullToRefresh from "../../PullToRefresh";

type MlJob = {
  job_id: string;
  state: string;
  priority: number | null;
  attempts: number;
  timestamp: number | null;
  finished_at: number | null;
  failed_reason: string | null;
  asset_id: number | null;
  filename: string | null;
  abs_path: string | null;
  media_type: string | null;
  ml_status: string | null;
  ml_error: string | null;
  face_count: number | null;
  has_text: boolean;
};

// The moment a run is best sorted/labelled by: when it finished, else when it
// was enqueued (still active/queued runs have no finished_at yet).
const runWhen = (j: MlJob) => j.finished_at ?? j.timestamp ?? 0;

function formatWhen(ts: number | null): string {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

// What a landed run produced, in one compact phrase.
function resultLabel(j: MlJob): string | null {
  if (j.state !== "completed") return null;
  if (j.face_count == null) return null;
  const faces = `${j.face_count} face${j.face_count === 1 ? "" : "s"}`;
  return j.has_text ? `${faces} · text` : faces;
}

export default function MlQueuePanel() {
  const [items, setItems] = useState<MlJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const busyRef = useRef<string | null>(null);
  busyRef.current = busy;

  const load = useCallback(async () => {
    try {
      const d = await fetchJson<{ items: MlJob[] }>(
        "/api/pipeline/queue?name=ml",
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
          body: JSON.stringify({ name: "ml", jobId }),
        });
        const d = await r.json();
        if (r.ok && d.removed) {
          setItems((prev) => prev.filter((j) => j.job_id !== jobId));
          setMsg("Removed from the ML queue.");
        } else {
          setMsg(`Couldn’t remove: ${d.reason ?? "unknown"}`);
        }
      } finally {
        setBusy(null);
      }
    },
    [busy],
  );

  const sorted = useMemo(
    () => [...items].sort((a, b) => runWhen(b) - runWhen(a)),
    [items],
  );

  const totals = useMemo(() => {
    let running = 0;
    let done = 0;
    let failed = 0;
    for (const j of items) {
      if (j.state === "completed") done++;
      else if (j.state === "failed") failed++;
      else running++;
    }
    return { running, done, failed };
  }, [items]);

  return (
    <PullToRefresh className="pl-section" onRefresh={load}>
      <div className="filterbar">
        <span className="hint">
          Every run of the ML queue, newest first: what’s being analyzed right
          now, what’s waiting, and past runs with their result — or, for
          failures, the reason. Queued runs can be pulled out.
        </span>
        <span className="spacer" />
        {items.length > 0 && (
          <span className="counters">
            <span className="pill pending">{totals.running} running/queued</span>
            <span className="pill ready">{totals.done} done</span>
            <span className="pill error">{totals.failed} failed</span>
          </span>
        )}
        <button className="btn btn-sm" onClick={load} disabled={loading}>
          Refresh
        </button>
      </div>

      {error && (
        <div className="error-box">
          <span>Couldn’t load the ML queue: {error}</span>
          <button className="btn" onClick={load}>
            Retry
          </button>
        </div>
      )}
      {msg && <p className="hint">{msg}</p>}

      {loading ? (
        <div className="spinner">Loading…</div>
      ) : sorted.length === 0 ? (
        <EmptyState
          icon={Icons.photoSearch}
          title="ML queue is empty"
          hint="No analysis jobs are running, queued, or in the recent history."
        />
      ) : (
        <div className="pl-run-list">
          {sorted.map((j) => {
            const result = resultLabel(j);
            return (
              <div key={j.job_id} className="pl-run">
                <span
                  className={`pill${
                    j.state === "failed"
                      ? " error"
                      : j.state === "completed"
                        ? " ready"
                        : " pending"
                  }`}
                >
                  {j.state}
                </span>
                <span className="pl-run-when">{formatWhen(runWhen(j))}</span>
                <span className="pl-run-meta" title={j.abs_path ?? undefined}>
                  {j.asset_id != null
                    ? `#${j.asset_id} · ${j.filename ?? "?"}${
                        j.media_type ? ` (${j.media_type})` : ""
                      }`
                    : `job #${j.job_id}`}
                  {result ? ` — ${result}` : ""}
                  {j.attempts > 1 ? ` · ${j.attempts} attempt(s)` : ""}
                </span>
                <span className="spacer" />
                <button
                  className="btn btn-sm btn-reject"
                  onClick={() => remove(j.job_id)}
                  disabled={busy != null || j.state === "active"}
                  title={
                    j.state === "active"
                      ? "Can’t remove a job that is running"
                      : "Remove this run from the queue history"
                  }
                >
                  {busy === j.job_id ? "…" : "Remove"}
                </button>
                {(j.failed_reason || j.ml_error) && (
                  <div className="pl-err pl-run-err">
                    {j.failed_reason ?? j.ml_error}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </PullToRefresh>
  );
}
