"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchJson } from "@/lib/fetchJson";

// Exports tab: view the exports that were made (thumbnails reused from
// the source assets' derivatives) and delete them once no longer needed (erases the
// RAW copies from the export folder and reverts the assets to 'triaged').

type ExportJob = {
  id: number;
  name: string;
  target: string;
  status: string;
  created_at: string;
  finished_at: string | null;
  result: {
    dest_dir?: string;
    total?: number;
    copied?: number;
    errors?: unknown[];
    error?: string;
  } | null;
  export_count: number;
  sample_asset_ids: number[];
};

function fmtDate(s: string | null): string {
  if (!s) return "—";
  try {
    return new Date(s).toLocaleDateString("en-GB");
  } catch {
    return s;
  }
}

function statusPill(status: string): string {
  if (status === "done") return "ready";
  if (status === "error") return "error";
  return "pending";
}

export default function ExportsTab() {
  const [jobs, setJobs] = useState<ExportJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await fetchJson<{ jobs?: ExportJob[] }>("/api/exports");
      setJobs(d.jobs ?? []);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function del(job: ExportJob) {
    if (
      !confirm(
        `Delete export “${job.name}”?\nThis removes the copied RAW files from the export folder and reverts these photos to 'triaged'.`,
      )
    )
      return;
    setBusy(job.id);
    try {
      await fetch(`/api/exports/${job.id}`, { method: "DELETE" });
      await load();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="tab-pane sessions-pane">
      {error && (
        <div className="error-box">
          <span>Couldn’t load exports: {error}</span>
          <button className="btn" onClick={load}>
            Retry
          </button>
        </div>
      )}
      {loading ? (
        <div className="spinner">Loading…</div>
      ) : jobs.length === 0 ? (
        <div className="empty">No exports yet. Pick some photos and export them → C1.</div>
      ) : (
        <div className="session-list">
          {jobs.map((job) => (
            <div key={job.id} className="session-card">
              <div style={{ flex: 1, minWidth: 200 }}>
                <h3>{job.name}</h3>
                <div className="meta">
                  {job.target} · {fmtDate(job.created_at)} · {job.export_count} files
                  {job.result?.copied != null
                    ? ` · ${job.result.copied}/${job.result.total ?? job.export_count} copied`
                    : ""}
                  {job.result?.error ? ` · ${job.result.error}` : ""}
                </div>
                {job.sample_asset_ids.length > 0 && (
                  <div className="thumb-strip">
                    {job.sample_asset_ids.map((id) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        key={id}
                        src={`/api/assets/${id}/thumb`}
                        alt=""
                        loading="lazy"
                      />
                    ))}
                  </div>
                )}
              </div>
              <div
                style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}
              >
                <span className={`pill ${statusPill(job.status)}`}>{job.status}</span>
                <button
                  className="btn btn-reject"
                  disabled={busy === job.id}
                  onClick={() => del(job)}
                >
                  {busy === job.id ? "…" : "Delete"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
