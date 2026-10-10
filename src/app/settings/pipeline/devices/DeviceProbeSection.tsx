"use client";

// Step 1 of Settings › Pipeline › Devices — the UI half of lib/deviceProbe.ts
// (migration 0049).
//
// Before anything is voted on, the clips that DO name their camera are asked:
// a DJI MP4 carries no Make/Model atom, but the first sample of its metadata
// track names the camera exactly as its stills spell it (`DJI FC8482`). The
// step is ONE verb while clips remain unread, and says "done" once none does —
// the indexer reads every clip it indexes from now on, so after one pass the
// step only comes back for a clip that could not be read.
//
// The pass runs on the integrity queue at the scan's pace, paused by its pause;
// clicking again resumes, since it only ever opens clips still unread. The job
// id survives a reload in localStorage, like the capture-day re-read.
import { useEffect, useRef, useState } from "react";
import { Spinner } from "../../../ui";
import { friendlyCameraName } from "@/lib/cameraLabels";
import { fetchJson } from "@/lib/fetchJson";
import type { ProbeReport } from "@/lib/deviceTypes";

const POLL_MS = 2000;
const STORAGE_KEY = "winnow.device-probe.job";

type JobInfo = {
  id: string;
  state: string;
  progress: { probed?: number; remaining?: number } | null;
  result: ProbeReport | null;
  failedReason: string | null;
};

const n = (v: number | undefined) => (v ?? 0).toLocaleString();
/** The count with the sentence that fits it: "1 clip … its" / "3 clips … their". */
const say = (v: number, one: string, many: string) => `${n(v)} ${v === 1 ? one : many}`;

function remember(id: string | null) {
  try {
    if (id) localStorage.setItem(STORAGE_KEY, id);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage disabled: the job just isn't followed across a reload */
  }
}

export default function DeviceProbeSection({
  onChanged,
}: {
  /** Called once a pass finishes: the folder list below has moved. */
  onChanged: () => void | Promise<void>;
}) {
  const [unprobed, setUnprobed] = useState<number | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<JobInfo | null>(null);
  // How many clips the running pass had in front of it, when this page
  // started it — a bar needs a whole; a job adopted after a reload has none.
  const [total, setTotal] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The host's callback, read when a pass ends — held in a ref so a host that
  // passes a fresh function each render does not restart the polling.
  const changed = useRef(onChanged);
  changed.current = onChanged;

  const count = async () => {
    try {
      setUnprobed(
        (await fetchJson<{ unprobed: number }>("/api/pipeline/device-probe")).unprobed,
      );
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  useEffect(() => {
    void count();
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) setJobId(saved);
    } catch {
      /* storage disabled: start fresh */
    }
  }, []);

  useEffect(() => {
    if (!jobId) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/pipeline/device-probe?job_id=${encodeURIComponent(jobId)}`);
        if (r.status === 404) {
          setJobId(null);
          remember(null);
          return;
        }
        const body = (await r.json()) as { job: JobInfo };
        if (stop) return;
        setJob(body.job);
        if (body.job.state === "completed" || body.job.state === "failed") {
          void count();
          void changed.current();
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
  }, [jobId]);

  async function start() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetchJson<{ job_id: string }>("/api/pipeline/device-probe", {
        method: "POST",
      });
      setJob(null);
      setTotal(unprobed);
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
  const state = running
    ? "running"
    : unprobed == null
      ? "loading"
      : unprobed > 0
        ? "todo"
        : "done";
  const read = job?.progress?.probed ?? 0;

  return (
    <section className="flow-step" data-state={state} aria-labelledby="device-probe-title">
      <header className="flow-step-head">
        <span className="flow-num" aria-hidden>
          {state === "done" ? "✓" : "1"}
        </span>
        <h2 id="device-probe-title">Ask the clips themselves</h2>
        <span className="flow-state">
          {state === "running" ? "Running" : state === "todo" ? "To do" : state === "done" ? "Done" : ""}
        </span>
      </header>
      <p className="hint">
        A DJI clip names no camera where photos do, but the first record of its own
        metadata track does — exactly as its stills spell it. That is the file speaking: it
        replaces a body the vote or a hand-pick gave, and never one you corrected yourself.
      </p>

      {state === "loading" && <Spinner />}

      {state === "todo" && (
        <div className="flow-actions">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void start()}>
            Read {n(unprobed ?? 0)} clip{unprobed === 1 ? "" : "s"}
          </button>
          <span className="hint">
            Videos whose file names no body and were never read. A few kilobytes of each, at
            the scan’s pace — pausing the scan pauses it, clicking again picks up where it
            stopped.
          </span>
        </div>
      )}

      {state === "running" && (
        <div className="flow-run" role="status">
          <div className="flow-progress" aria-hidden>
            <span
              style={{ width: total ? `${Math.min(100, (read / total) * 100)}%` : undefined }}
              data-indeterminate={!total || undefined}
            />
          </div>
          <span className="hint">
            <Spinner sm /> Reading clips… {total ? `${n(read)} of ${n(total)}` : n(read)}
          </span>
        </div>
      )}

      {state === "done" && !report && (
        <p>Every clip has been read. New ones are read as they are indexed.</p>
      )}

      {msg && <p className="hint">{msg}</p>}
      {job?.state === "failed" && <p className="hint">The pass failed: {job.failedReason}</p>}
      {report && <ProbeReportView report={report} />}
    </section>
  );
}

function ProbeReportView({ report }: { report: ProbeReport }) {
  const cameras = Object.entries(report.cameras).sort((a, b) => b[1] - a[1]);
  return (
    <div className="hint card-rules">
      <p>
        <strong>
          {report.stopped ? "Paused — click again to finish." : "Read."}
        </strong>{" "}
        {n(report.probed)} clip{report.probed === 1 ? "" : "s"} read
        {cameras.length > 0 && (
          <>
            {" "}— naming{" "}
            {cameras
              .map(([c, k]) => `${friendlyCameraName(c)} (${n(k)})`)
              .join(", ")}
          </>
        )}
        .
      </p>
      <ul>
        {report.filled > 0 && (
          <li>{say(report.filled, "had no body and now carries its own.", "had no body and now carry their own.")}</li>
        )}
        {report.confirmed > 0 && (
          <li>
            {say(report.confirmed, "already carried the right one", "already carried the right one")} —
            now from the file, not a guess.
          </li>
        )}
        {report.corrected > 0 && (
          <li>
            <strong>
              {say(report.corrected, "carried a body its file contradicts, and now carries the file’s.", "carried a body their file contradicts, and now carry the file’s.")}
            </strong>
          </li>
        )}
        {report.overridden > 0 && (
          <li>
            {say(report.overridden, "you corrected by hand was left as it is;", "you corrected by hand were left as they are;")}{" "}
            what the file says is recorded beside it.
          </li>
        )}
        {report.untold > 0 && (
          <li>
            {say(report.untold, "carries", "carry")} a DJI track naming no camera this reader
            knows yet — aircraft and serial are recorded, the body is left to the vote below.
          </li>
        )}
        {report.noTrack > 0 && (
          <li>{say(report.noTrack, "has", "have")} no such track (phone clips, edits, exports).</li>
        )}
        {report.unreadable > 0 && (
          <li>
            {say(report.unreadable, "could not be opened and stays", "could not be opened and stay")}{" "}
            unread — a missing file or an unmounted share. The next pass tries again.
          </li>
        )}
      </ul>
      {report.corrections.length > 0 && (
        <details>
          <summary>
            The {report.corrected > report.corrections.length
              ? `first ${n(report.corrections.length)} of ${n(report.corrected)}`
              : n(report.corrections.length)}{" "}
            correction{report.corrected === 1 ? "" : "s"}
          </summary>
          <ul>
            {report.corrections.map((c) => (
              <li key={c.id}>
                <code>{c.filename}</code>: {c.from ? friendlyCameraName(c.from) : "none"} →{" "}
                {friendlyCameraName(c.to)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
