"use client";

// Scan (index) queue history: every root's scan runs — active, queued, and past
// completions/failures — grouped by root so repeat scans of the same folder read
// as one timeline instead of a flat, hard-to-scan list.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchJson } from "@/lib/fetchJson";
import { EmptyState, Icons } from "../../ui";
import PullToRefresh from "../../PullToRefresh";

type ScanJob = {
  job_id: string;
  state: string;
  priority: number | null;
  attempts: number;
  timestamp: number | null;
  finished_at: number | null;
  failed_reason: string | null;
  root_id: number | null;
  path: string | null;
  kind: string | null;
};

type RootGroup = {
  key: string;
  path: string | null;
  rootId: number | null;
  kind: string | null;
  runs: ScanJob[];
};

// The moment a run is best sorted/labelled by: when it finished, else when it
// was enqueued (still active/queued runs have no finished_at yet).
const runWhen = (j: ScanJob) => j.finished_at ?? j.timestamp ?? 0;

const RUNNING_STATES = new Set(["active", "waiting", "prioritized", "delayed"]);

function groupByRoot(items: ScanJob[]): RootGroup[] {
  const groups = new Map<string, RootGroup>();
  for (const j of items) {
    const key =
      j.root_id != null
        ? `root:${j.root_id}`
        : j.path
          ? `path:${j.path}`
          : `job:${j.job_id}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, path: j.path, rootId: j.root_id, kind: j.kind, runs: [] };
      groups.set(key, g);
    }
    g.runs.push(j);
  }
  for (const g of groups.values()) g.runs.sort((a, b) => runWhen(b) - runWhen(a));
  return [...groups.values()].sort(
    (a, b) => runWhen(b.runs[0]) - runWhen(a.runs[0]),
  );
}

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

const VISIBLE_RUNS = 4;

export default function ScanningPage() {
  const [items, setItems] = useState<ScanJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
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

  const toggleExpanded = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const groups = useMemo(() => groupByRoot(items), [items]);

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
          Every root’s scan runs, grouped by folder and ordered by when they ran.
          Active/queued scans can be pulled out; past runs show their result and,
          for failures, the reason.
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
          <span>Couldn’t load the scan queue: {error}</span>
          <button className="btn" onClick={load}>
            Retry
          </button>
        </div>
      )}
      {msg && <p className="hint">{msg}</p>}

      {loading ? (
        <div className="spinner">Loading…</div>
      ) : groups.length === 0 ? (
        <EmptyState
          icon={Icons.pipeline}
          title="Scan queue is empty"
          hint="No folders are being indexed, queued, or have a scan history yet."
        />
      ) : (
        <div className="pl-group-list">
          {groups.map((g) => (
            <RootGroupCard
              key={g.key}
              group={g}
              expanded={expanded.has(g.key)}
              onToggleExpanded={() => toggleExpanded(g.key)}
              busy={busy}
              onRemove={remove}
            />
          ))}
        </div>
      )}
    </PullToRefresh>
  );
}

function RootGroupCard({
  group,
  expanded,
  onToggleExpanded,
  busy,
  onRemove,
}: {
  group: RootGroup;
  expanded: boolean;
  onToggleExpanded: () => void;
  busy: string | null;
  onRemove: (jobId: string) => void;
}) {
  const runs = expanded ? group.runs : group.runs.slice(0, VISIBLE_RUNS);
  const hiddenCount = group.runs.length - runs.length;
  const done = group.runs.filter((j) => j.state === "completed").length;
  const failed = group.runs.filter((j) => j.state === "failed").length;
  const running = group.runs.length - done - failed;

  return (
    <div className="pl-group">
      <div className="pl-group-head">
        <span className="pl-folder-icon">{Icons.folder}</span>
        <span className="pl-group-title">
          {group.path ?? `Root #${group.rootId ?? "?"}`}
        </span>
        {group.kind && <span className="pill">{group.kind}</span>}
        <span className="spacer" />
        <span className="pl-group-stats">
          {running > 0 && <span className="pill pending">{running} active</span>}
          {done > 0 && <span className="pill ready">{done} done</span>}
          {failed > 0 && <span className="pill error">{failed} failed</span>}
        </span>
      </div>

      {/* Compact oldest→newest run strip: a glance at this root's scan history. */}
      <div className="pl-run-strip" aria-hidden="true">
        {[...group.runs]
          .slice()
          .reverse()
          .map((j) => (
            <span
              key={j.job_id}
              className={`pl-run-dot is-${j.state}`}
              title={`${j.state} · ${formatWhen(runWhen(j))}`}
            />
          ))}
      </div>

      <div className="pl-run-list">
        {runs.map((j) => (
          <div key={j.job_id} className="pl-run">
            <span className={`pill${j.state === "failed" ? " error" : j.state === "completed" ? " ready" : " pending"}`}>
              {j.state}
            </span>
            <span className="pl-run-when">{formatWhen(runWhen(j))}</span>
            {j.priority != null && j.priority <= 1 && (
              <span className="pill picks">priority</span>
            )}
            <span className="pl-run-meta">
              job #{j.job_id}
              {j.attempts ? ` · ${j.attempts} attempt(s)` : ""}
            </span>
            <span className="spacer" />
            <button
              className="btn btn-sm btn-reject"
              onClick={() => onRemove(j.job_id)}
              disabled={busy != null || j.state === "active"}
              title={
                j.state === "active"
                  ? "Can’t remove a scan that is running"
                  : "Remove this run from the queue history"
              }
            >
              {busy === j.job_id ? "…" : "Remove"}
            </button>
            {j.failed_reason && (
              <div className="pl-err pl-run-err">{j.failed_reason}</div>
            )}
          </div>
        ))}
      </div>

      {hiddenCount > 0 && (
        <button className="btn btn-sm pl-run-more" onClick={onToggleExpanded}>
          Show {hiddenCount} more run{hiddenCount > 1 ? "s" : ""}
        </button>
      )}
      {expanded && group.runs.length > VISIBLE_RUNS && (
        <button className="btn btn-sm pl-run-more" onClick={onToggleExpanded}>
          Show less
        </button>
      )}
    </div>
  );
}
