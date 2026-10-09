"use client";

// Step 1 of Settings › Pipeline › Dates & places — the UI half of
// lib/captureDays.ts (migration 0046).
//
// Every frame used to be filed on its UTC day, so a sunrise in Queensland
// landed on the day before. Placing it on its LOCAL day needs to know whether
// its stored time is a zoned instant or a bare wall clock, and a frame indexed
// before 0046 never recorded which: only its file's date tags can say. So the
// step is ONE verb while such frames remain — read their dates — and says
// "done" once none does. The database-only passes (recompute the days, and a
// dry run of them in a rolled-back transaction) sit under "More": the indexer,
// a geotag and a track import already run them on what they touch.
//
// The re-read runs on the integrity queue at the scan's pace, paused by its
// pause; clicking again resumes, since it only ever opens rows still to read.
// The job id survives a locked phone in localStorage, like the relink pass.
import { useEffect, useRef, useState } from "react";
import { Spinner } from "../../../ui";
import { fetchJson } from "@/lib/fetchJson";
import type { CaptureBackfillReport, CaptureDayStats } from "@/lib/captureDays";

const POLL_MS = 2000;
const STORAGE_KEY = "winnow.capture-days.job";
/** Fired by another section (the track import) that queued a job of ours. */
export const CAPTURE_DAYS_EVENT = "winnow:capture-days-job";

type JobInfo = {
  id: string;
  state: string;
  data: { apply: boolean; reread: boolean; from?: string; to?: string } | null;
  progress: { reread?: number; failed?: number } | null;
  result: CaptureBackfillReport | null;
  failedReason: string | null;
};

const OFFSET_LABEL: Record<string, string> = {
  gps: "The frame’s own position",
  track: "An imported GPS track",
  neighbour: "A frame shot nearby in time",
  exif: "The camera’s stated zone",
  none: "No place known yet (UTC day, or its own wall clock)",
};

const n = (v: number | undefined) => (v ?? 0).toLocaleString();

function remember(id: string | null) {
  try {
    if (id) localStorage.setItem(STORAGE_KEY, id);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage disabled: the job just isn't followed across a reload */
  }
}

export default function CaptureDaysSection({
  stats,
  windowH,
  onChanged,
}: {
  stats: CaptureDayStats | null;
  windowH: number;
  onChanged: () => void | Promise<void>;
}) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<JobInfo | null>(null);
  // How many files the running re-read had in front of it, when this page
  // started it — a bar needs a whole; a job adopted after a reload has none.
  const [total, setTotal] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) setJobId(saved);
    } catch {
      /* storage disabled: start fresh */
    }
    const adopt = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (!id) return;
      setJob(null);
      setTotal(null);
      setJobId(id);
      remember(id);
    };
    window.addEventListener(CAPTURE_DAYS_EVENT, adopt);
    return () => window.removeEventListener(CAPTURE_DAYS_EVENT, adopt);
  }, []);

  useEffect(() => {
    if (!jobId) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/pipeline/capture-days?job_id=${encodeURIComponent(jobId)}`);
        if (r.status === 404) {
          setJobId(null);
          remember(null);
          return;
        }
        const body = (await r.json()) as { job: JobInfo };
        if (stop) return;
        setJob(body.job);
        if (body.job.state === "completed" || body.job.state === "failed") {
          void onChanged();
          return;
        }
      } catch {
        /* transient: try again */
      }
      if (!stop) timer.current = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      stop = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [jobId, onChanged]);

  async function start(apply: boolean, reread: boolean) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetchJson<{ job_id: string }>("/api/pipeline/capture-days", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apply, reread }),
      });
      setJob(null);
      setTotal(reread ? (stats?.toRead ?? null) : null);
      setJobId(r.job_id);
      remember(r.job_id);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const running = job != null && job.state !== "completed" && job.state !== "failed";
  const report = job?.state === "completed" ? job.result : null;
  const toRead = stats?.toRead ?? 0;
  const state = running ? "running" : !stats ? "loading" : toRead > 0 ? "todo" : "done";
  const read = job?.progress?.reread ?? 0;

  return (
    <section className="flow-step" data-state={state} aria-labelledby="capture-days-title">
      <header className="flow-step-head">
        <span className="flow-num" aria-hidden>
          {state === "done" ? "✓" : "1"}
        </span>
        <h2 id="capture-days-title">Read the capture times</h2>
        <span className="flow-state">
          {state === "running" ? "Running" : state === "todo" ? "To do" : state === "done" ? "Done" : ""}
        </span>
      </header>
      <p className="hint">
        A frame belongs to the day on the photographer’s wall clock, not the UTC one, and the
        place decides it: the frame’s own position, else an imported track, else a frame from
        any device shot within {windowH} h, else the zone the camera wrote.
      </p>

      {state === "loading" && <Spinner />}

      {state === "todo" && (
        <>
          <p>
            <strong>{n(toRead)}</strong> file(s) were indexed before Winnow told a zoned time
            from a bare wall clock. Their date tags need one more read.
          </p>
          <div className="flow-actions">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => start(true, true)}>
              Read their dates
            </button>
            <span className="hint">
              Only each original’s header, at the scan’s pace — pausing the scan pauses it, and
              clicking again picks up where it stopped.
            </span>
          </div>
        </>
      )}

      {state === "running" && (
        <div className="flow-run" role="status">
          <div className="flow-progress" aria-hidden>
            <span
              style={{
                width:
                  job?.data?.reread && total
                    ? `${Math.min(100, (read / total) * 100)}%`
                    : undefined,
              }}
              data-indeterminate={!(job?.data?.reread && total) || undefined}
            />
          </div>
          <span className="hint">
            <Spinner sm />{" "}
            {job?.data?.reread
              ? total
                ? `Reading dates… ${n(read)} of ${n(total)} files`
                : `Reading dates… ${n(read)} files`
              : job?.data?.apply
                ? "Recomputing the days…"
                : "Dry run…"}
          </span>
        </div>
      )}

      {state === "done" && stats && (
        <p>
          Every capture time is read. <strong>{n(stats.movedFromUtcDay)}</strong> frame(s) sit on
          a local day that is not their UTC day.
        </p>
      )}

      {msg && <p className="hint">{msg}</p>}
      {job?.state === "failed" && <p className="hint">The job failed: {job.failedReason}</p>}
      {report && <ReportView report={report} />}

      {stats && (
        <details className="card-rules hint">
          <summary>Where each frame’s day comes from · more</summary>
          <div className="vol-table-wrap">
            <table className="vol-table">
              <tbody>
                {Object.entries(stats.byOffset)
                  .sort((a, b) => b[1] - a[1])
                  .map(([k, v]) => (
                    <tr key={k}>
                      <td>{OFFSET_LABEL[k] ?? k}</td>
                      <td>{n(v)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <p>
            The days are recomputed by themselves whenever a position arrives (a scan, a geotag,
            a track). To run it over the whole library again, or see first what it would change:
          </p>
          <div className="flow-actions">
            <button type="button" className="btn btn-sm" disabled={busy || running} onClick={() => start(true, false)}>
              Recompute the days
            </button>
            <button type="button" className="btn btn-sm" disabled={busy || running} onClick={() => start(false, false)}>
              Dry run
            </button>
          </div>
        </details>
      )}
    </section>
  );
}

function ReportView({ report }: { report: CaptureBackfillReport }) {
  const moved = report.after.movedFromUtcDay - report.before.movedFromUtcDay;
  return (
    <div className="hint card-rules">
      <p>
        <strong>
          {!report.apply ? "Dry run — nothing was written." : report.reread ? "Dates read." : "Days recomputed."}
        </strong>{" "}
        {n(report.fromPosition)} frame(s) dated by their own position, {n(report.fromNeighbour)} by
        a frame shot nearby.
        {report.apply && (
          <>
            {" "}
            On a day other than their UTC day: {n(report.before.movedFromUtcDay)} →{" "}
            {n(report.after.movedFromUtcDay)} ({moved >= 0 ? "+" : ""}
            {n(moved)}).
          </>
        )}
      </p>
      {report.relabelled > 0 && (
        <p>
          {n(report.relabelled)} clip(s) an earlier read had marked as having no date were read
          again — their time and day are unchanged.
        </p>
      )}
      {report.reread && (
        <p>
          {n(report.reread_files)} file(s) read
          {report.range ? ` (${report.range.from.slice(0, 10)} → ${report.range.to.slice(0, 10)} only)` : ""},{" "}
          {n(report.reread_failed)} unreadable, {n(report.captured_at_changed)} whose stored time
          now follows the file.
          {report.stopped && " Paused before the end — click again to resume."}
        </p>
      )}
    </div>
  );
}
