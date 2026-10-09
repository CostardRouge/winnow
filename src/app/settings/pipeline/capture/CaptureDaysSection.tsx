"use client";

// Settings › Pipeline › Dates & places › "Local capture day" — the UI half of
// lib/captureDays.ts (migration 0046).
//
// Every frame used to be filed on its UTC day, so a sunrise in Queensland
// landed on the day before. The repair is three gestures over one queued job:
// PREVIEW (the database-only steps in a rolled-back transaction — nothing is
// written, the report says what would move), APPLY (the same steps, kept), and
// APPLY + RE-READ (also reads the date tags of the rows the database cannot
// classify — the originals' headers, at the scan's pace, paused by its pause).
// Re-clicking a stopped re-read resumes it: it only ever works on rows still
// unclassified.
//
// The job id survives a locked phone in localStorage, like the relink pass.
import { useCallback, useEffect, useRef, useState } from "react";
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
  data: { apply: boolean; reread: boolean } | null;
  progress: { reread?: number; failed?: number } | null;
  result: CaptureBackfillReport | null;
  failedReason: string | null;
};

const SOURCE_LABEL: Record<string, string> = {
  exif: "EXIF time with a zone",
  "exif-wall": "EXIF wall clock, no zone",
  file: "No EXIF date (file date)",
  unclassified: "Not yet classified",
};
const OFFSET_LABEL: Record<string, string> = {
  gps: "The frame’s own position",
  track: "An imported GPS track",
  neighbour: "A nearby frame’s position",
  exif: "The camera’s stated zone",
  none: "Unknown (UTC day)",
};

const n = (v: number | undefined) => (v ?? 0).toLocaleString();

export default function CaptureDaysSection() {
  const [stats, setStats] = useState<CaptureDayStats | null>(null);
  const [windowH, setWindowH] = useState<number>(12);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<JobInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadStats = useCallback(async () => {
    try {
      const r = await fetchJson<{ stats: CaptureDayStats; neighbourWindowHours: number }>(
        "/api/pipeline/capture-days",
      );
      setStats(r.stats);
      setWindowH(r.neighbourWindowHours);
    } catch (e) {
      setMsg((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void loadStats();
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
      setJobId(id);
      try {
        localStorage.setItem(STORAGE_KEY, id);
      } catch {
        /* ignore */
      }
    };
    window.addEventListener(CAPTURE_DAYS_EVENT, adopt);
    return () => window.removeEventListener(CAPTURE_DAYS_EVENT, adopt);
  }, [loadStats]);

  useEffect(() => {
    if (!jobId) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch(
          `/api/pipeline/capture-days?job_id=${encodeURIComponent(jobId)}`,
        );
        if (r.status === 404) {
          setJobId(null);
          try {
            localStorage.removeItem(STORAGE_KEY);
          } catch {
            /* ignore */
          }
          return;
        }
        const body = (await r.json()) as { job: JobInfo };
        if (stop) return;
        setJob(body.job);
        if (body.job.state === "completed" || body.job.state === "failed") {
          void loadStats();
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
  }, [jobId, loadStats]);

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
      setJobId(r.job_id);
      try {
        localStorage.setItem(STORAGE_KEY, r.job_id);
      } catch {
        /* ignore */
      }
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const running = job != null && job.state !== "completed" && job.state !== "failed";
  const report = job?.state === "completed" ? job.result : null;

  return (
    <section className="pl-section" aria-labelledby="capture-days-title">
      <h2 id="capture-days-title" className="section-head">
        Local capture day
      </h2>
      <p className="hint card-rules">
        A frame belongs to the day on the photographer’s wall clock, not the
        UTC one. The day is decided by the place: the frame’s own position,
        else an imported track, else a frame from any device shot within{" "}
        {windowH} h, else the zone the camera wrote. Originals are never
        written; clearing the offsets restores the old days exactly.
      </p>

      {!stats ? (
        <Spinner />
      ) : (
        <div className="vol-table-wrap">
          <table className="vol-table">
            <thead>
              <tr>
                <th scope="col">Where each live frame’s day comes from</th>
                <th scope="col">Frames</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(stats.byOffset)
                .sort((a, b) => b[1] - a[1])
                .map(([k, v]) => (
                  <tr key={k}>
                    <td>{OFFSET_LABEL[k] ?? k}</td>
                    <td>{n(v)}</td>
                  </tr>
                ))}
              <tr>
                <td>
                  <strong>On a different day than their UTC day</strong>
                </td>
                <td>
                  <strong>{n(stats.movedFromUtcDay)}</strong>
                </td>
              </tr>
              <tr>
                <td>Times not yet classified (indexed before this repair)</td>
                <td>{n(stats.unclassified)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <div className="filterbar">
        <button
          type="button"
          className="btn"
          disabled={busy || running}
          onClick={() => start(false, false)}
        >
          Preview
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || running}
          onClick={() => start(true, false)}
        >
          Apply
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy || running || !stats?.unclassified}
          title="Also re-read the date tags of the frames the database cannot classify, at the scan’s pace"
          onClick={() => start(true, true)}
        >
          Apply + re-read dates
        </button>
        {running && (
          <span className="hint">
            <Spinner sm />{" "}
            {job?.data?.reread
              ? `Re-reading… ${n(job?.progress?.reread)} files`
              : job?.data?.apply
                ? "Applying…"
                : "Previewing…"}
          </span>
        )}
      </div>

      {msg && <p className="hint">{msg}</p>}
      {job?.state === "failed" && (
        <p className="hint">The job failed: {job.failedReason}</p>
      )}
      {report && <ReportView report={report} />}
    </section>
  );
}

function ReportView({ report }: { report: CaptureBackfillReport }) {
  const moved = report.after.movedFromUtcDay - report.before.movedFromUtcDay;
  return (
    <div className="hint card-rules">
      <p>
        <strong>{report.apply ? "Applied." : "Preview — nothing was written."}</strong>{" "}
        {n(report.fromPosition)} frame(s) dated by their own position,{" "}
        {n(report.fromNeighbour)} by a nearby frame’s, {n(report.classifiedFromDb)}{" "}
        time(s) classified from the database.
        {report.apply && (
          <>
            {" "}
            Frames on a different day than their UTC day: {n(report.before.movedFromUtcDay)} →{" "}
            {n(report.after.movedFromUtcDay)} ({moved >= 0 ? "+" : ""}
            {n(moved)}).
          </>
        )}
      </p>
      {report.relabelled > 0 && (
        <p>
          {n(report.relabelled)} clip(s) an earlier re-read had marked as having no date were
          handed back to the re-read — their time and day are unchanged.
        </p>
      )}
      {report.reread && (
        <p>
          {n(report.reread_files)} file(s) re-read, {n(report.reread_failed)} unreadable,{" "}
          {n(report.captured_at_changed)} whose stored time differed from the file.
          {report.stopped && " Paused before the end — click again to resume."}
        </p>
      )}
      {!report.apply && report.before.unclassified > 0 && (
        <p>
          {n(report.before.unclassified - report.classifiedFromDb)} time(s) can only be
          classified by re-reading their file’s date tags.
        </p>
      )}
    </div>
  );
}
