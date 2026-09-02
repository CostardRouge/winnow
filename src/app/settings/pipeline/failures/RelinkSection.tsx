"use client";

// Failures › Missing files › "Moved, not deleted" — the UI half of lib/relink.ts.
//
// Reorganising folders inside a volume makes every moved file look like a
// deletion (its row is flagged missing and auto-trashed) plus an unindexable
// duplicate, and no rescan ever undoes it. This section finds those files and
// moves each row back onto its file.
//
// Two steps on purpose, because the repair writes to rows the user can't easily
// inspect: SCAN runs a dry pass and shows exactly what it would do, then RELINK
// applies that same match. Both are queued jobs — the pass walks the whole
// volume, minutes of NAS I/O — and this component polls the job.
//
// The job id is kept in localStorage so a phone that locked mid-walk (the
// reason this exists at all: the box is headless and the maintainer is usually
// on mobile) picks the run back up on return instead of starting over.
import { useCallback, useEffect, useRef, useState } from "react";
import { Icons } from "../../../ui";
import { formatBytes } from "./model";
import type { RelinkJobInfo, RelinkRootReport } from "./model";

const POLL_MS = 2000;
const STORAGE_KEY = "winnow.relink.job";

// Rows rendered per volume before collapsing to a count: a 900-file
// reorganisation is realistic and nobody scrolls that on a phone.
const SHOW_ROWS = 12;

function totals(perRoot: RelinkRootReport[]) {
  return perRoot.reduce(
    (acc, r) => ({
      matched: acc.matched + r.report.matched,
      relinked: acc.relinked + r.report.relinked,
      rebuilds: acc.rebuilds + r.report.rebuilds,
      ambiguous: acc.ambiguous + r.report.ambiguous,
      skipped: acc.skipped + r.report.skippedCount,
      orphans: acc.orphans + r.report.orphans,
    }),
    { matched: 0, relinked: 0, rebuilds: 0, ambiguous: 0, skipped: 0, orphans: 0 },
  );
}

export default function RelinkSection({
  onChanged,
  setMsg,
}: {
  onChanged: () => Promise<unknown> | void;
  setMsg: (s: string) => void;
}) {
  const [job, setJob] = useState<RelinkJobInfo | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // The last COMPLETED apply, kept so its outcome stays on screen after the
  // dry-run state is cleared.
  const [done, setDone] = useState<string | null>(null);
  const notified = useRef<string | null>(null);

  // Resume whatever was running when the page (or the phone) went away.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) setJobId(saved);
    } catch {
      /* private mode / storage disabled: just start fresh */
    }
  }, []);

  const poll = useCallback(async (id: string) => {
    try {
      const r = await fetch(`/api/failures/relink?job_id=${encodeURIComponent(id)}`);
      if (r.status === 404) {
        // Retained job rotated out of the queue: stop chasing it.
        setJobId(null);
        try {
          localStorage.removeItem(STORAGE_KEY);
        } catch {
          /* ignore */
        }
        return;
      }
      if (!r.ok) return; // transient: the next tick tries again
      setJob(((await r.json()) as { job: RelinkJobInfo }).job);
    } catch {
      /* transient network error: keep polling */
    }
  }, []);

  useEffect(() => {
    if (!jobId) return;
    poll(jobId);
    const t = setInterval(() => poll(jobId), POLL_MS);
    return () => clearInterval(t);
  }, [jobId, poll]);

  const finished = job?.state === "completed" || job?.state === "failed";
  const running = jobId != null && !finished;
  const perRoot = job?.result?.perRoot ?? [];
  const sum = totals(perRoot);
  const wasApply = job?.data?.apply === true;

  // Refresh the missing list once an APPLY lands — its rows are exactly what
  // just changed. Guarded so it fires once per job, not on every poll tick.
  useEffect(() => {
    if (!job || job.state !== "completed" || notified.current === job.id) return;
    notified.current = job.id;
    if (job.data?.apply) {
      const t = totals(job.result?.perRoot ?? []);
      setDone(
        t.relinked
          ? `Relinked ${t.relinked} file(s).${
              t.rebuilds
                ? ` ${t.rebuilds} lost their derivatives to a purge and are rebuilding — the ML pass follows on its own.`
                : ""
            }`
          : "Nothing was relinked — the matches were resolved or claimed in the meantime.",
      );
      onChanged();
    }
  }, [job, onChanged]);

  async function start(apply: boolean) {
    if (busy || running) return;
    setBusy(true);
    setMsg("");
    setConfirming(false);
    if (apply) setDone(null);
    try {
      const r = await fetch("/api/failures/relink", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apply }),
      });
      const d = await r.json();
      if (!r.ok) {
        setMsg(`Error: ${d.error ?? "unknown"}`);
        return;
      }
      notified.current = null;
      setJob(null);
      setJobId(d.job_id);
      try {
        localStorage.setItem(STORAGE_KEY, d.job_id);
      } catch {
        /* ignore */
      }
    } finally {
      setBusy(false);
    }
  }

  function dismiss() {
    setJobId(null);
    setJob(null);
    setDone(null);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }

  return (
    <section style={{ marginBottom: 28 }}>
      <div className="filterbar" style={{ marginBottom: 6 }}>
        <h3 style={{ margin: 0 }}>Moved, not deleted</h3>
        <span className="spacer" />
        {(finished || done) && (
          <button className="btn" onClick={dismiss} disabled={busy}>
            Dismiss
          </button>
        )}
        <button
          className="btn"
          onClick={() => start(false)}
          disabled={busy || running}
          title="Walk the volumes and match every missing file to the file that now holds its content. Writes nothing."
        >
          {Icons.search}
          <span>{running && !wasApply ? "Scanning…" : "Scan for moved files"}</span>
        </button>
      </div>

      <p className="hint" style={{ marginTop: 0 }}>
        Reorganising folders <strong>inside</strong> a volume makes every moved
        file look like two unrelated things: its row is reported missing and
        auto-trashed above, while the file at its new path is dropped as an
        unindexable duplicate. Rescanning repeats that forever, and{" "}
        <strong>Restore</strong> only brings the row back still pointing at the
        old path. This finds them by content and moves each row onto its file,
        keeping its rating, tags, pairing and burst. Files that were{" "}
        <strong>purged</strong> are recovered too — a purge never released their
        content hash, so they are still matchable; only their derivatives and
        face/search data are rebuilt afterwards.
      </p>

      {running && (
        <div className="empty" style={{ padding: 16 }}>
          {job?.state === "active" || job == null
            ? `Walking the volumes${wasApply ? " and relinking" : ""}… this reads every folder on the NAS, so it can take a few minutes.`
            : "Queued — it starts as soon as the disk is free. A paused pipeline holds it."}
          <br />
          <span className="hint">
            Safe to leave this page or lock your phone; the run continues and
            this section picks it back up.
          </span>
        </div>
      )}

      {job?.state === "failed" && (
        <div className="error-box">
          <span>Relink failed: {job.failedReason ?? "unknown error"}</span>
        </div>
      )}

      {done && <p className="hint">{done}</p>}

      {finished && job?.state === "completed" && (
        <>
          <div className="filterbar" style={{ marginBottom: 6 }}>
            <strong>
              {sum.matched === 0
                ? "No moved file found."
                : wasApply
                  ? `${sum.relinked} of ${sum.matched} match(es) relinked.`
                  : `${sum.matched} moved file(s) found.`}
            </strong>
            {sum.ambiguous > 0 && (
              <span className="pill">{sum.ambiguous} ambiguous</span>
            )}
            {sum.rebuilds > 0 && (
              <span className="pill">{sum.rebuilds} need a rebuild</span>
            )}
            <span className="spacer" />
            {!wasApply && sum.matched > 0 && !confirming && (
              <button
                className="btn btn-primary"
                onClick={() => setConfirming(true)}
                disabled={busy}
              >
                {Icons.undo}
                <span>Relink {sum.matched} file(s)</span>
              </button>
            )}
          </div>

          {confirming && (
            <div className="error-box">
              <span>
                Move {sum.matched} row(s) onto their new paths? Nothing on disk
                is touched — only the library's idea of where each file lives.
                {sum.rebuilds > 0 &&
                  ` ${sum.rebuilds} of them were purged and will rebuild their thumbnail and search data.`}
              </span>
              <button className="btn" onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={() => start(true)}>
                Relink
              </button>
            </div>
          )}

          {sum.orphans === 0 && (
            <p className="hint">
              No row is flagged missing, so there is nothing a move could
              explain.
            </p>
          )}

          {perRoot.map(({ root, report }) =>
            report.matched === 0 && report.skippedCount === 0 ? null : (
              <div key={root.id} style={{ marginBottom: 12 }}>
                <p className="hint" style={{ marginBottom: 4 }}>
                  <strong>{root.path}</strong> — {report.matched} match(es) from{" "}
                  {report.orphans} missing row(s); walked {report.scanned} file(s).
                </p>
                <div className="fail-list">
                  {report.matches.slice(0, SHOW_ROWS).map((m) => (
                    <div key={m.assetId} className="fail-row">
                      <div className="fail-head">
                        <strong className="fail-title">
                          #{m.assetId} · {m.filename}
                        </strong>
                        {m.state === "purged" && (
                          <span className="pill">purged — rebuilds</span>
                        )}
                        {m.fileSize != null && (
                          <span className="pill">{formatBytes(m.fileSize)}</span>
                        )}
                      </div>
                      <div className="hint" style={{ wordBreak: "break-all" }}>
                        {m.oldPath}
                        <br />→ {m.newPath}
                      </div>
                    </div>
                  ))}
                </div>
                {report.matched > Math.min(SHOW_ROWS, report.matches.length) && (
                  <p className="hint">
                    … and{" "}
                    {report.matched - Math.min(SHOW_ROWS, report.matches.length)}{" "}
                    more.
                  </p>
                )}
                {report.skippedCount > 0 && (
                  <details>
                    <summary className="hint">
                      {report.skippedCount} skipped — why
                    </summary>
                    <div className="fail-list">
                      {report.skipped.map((s) => (
                        <div key={s.path} className="fail-row">
                          <div className="hint" style={{ wordBreak: "break-all" }}>
                            <strong>{s.path}</strong>
                            <br />
                            {s.reason}
                          </div>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            ),
          )}
        </>
      )}
    </section>
  );
}
