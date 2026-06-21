"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchJson } from "@/lib/fetchJson";
import { SkeletonCards, EmptyState, Icons } from "./ui";
import ExportCard, { type ExportJob } from "./exports/ExportCard";

// Exports tab: browse the exports that were made and act on each one — download
// it (whole archive or file by file, via the expandable card) or delete it
// (erases the RAW copies from the export folder and reverts the assets to
// 'triaged'). Thumbnails reuse the source assets' derivatives.

export default function ExportsTab() {
  const [jobs, setJobs] = useState<ExportJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // RAW+JPEG pairing preference: also copy the JPEG companion alongside the RAW
  // keeper. Persisted in app settings; applies to every export queued afterwards.
  const [includeJpeg, setIncludeJpeg] = useState(false);

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
    fetchJson<{ exportIncludeJpeg?: boolean }>("/api/settings")
      .then((s) => setIncludeJpeg(Boolean(s.exportIncludeJpeg)))
      .catch(() => {});
  }, [load]);

  const toggleIncludeJpeg = useCallback(async (next: boolean) => {
    setIncludeJpeg(next); // optimistic
    try {
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exportIncludeJpeg: next }),
      });
    } catch {
      setIncludeJpeg(!next); // revert on failure
    }
  }, []);

  return (
    <div className="tab-pane sessions-pane">
      <div className="exports-toolbar">
        <label className="export-opt" title="When a picked photo is a RAW+JPEG pair, also copy the JPEG next to the RAW keeper.">
          <input
            type="checkbox"
            checked={includeJpeg}
            onChange={(e) => toggleIncludeJpeg(e.target.checked)}
          />
          <span>Include JPEG companion in exports</span>
        </label>
      </div>
      {error && (
        <div className="error-box">
          <span>Couldn’t load exports: {error}</span>
          <button className="btn" onClick={load}>
            Retry
          </button>
        </div>
      )}
      {loading ? (
        <SkeletonCards rows={3} />
      ) : jobs.length === 0 ? (
        <EmptyState
          icon={Icons.export}
          title="No exports yet"
          hint="Pick photos in the gallery, then export them as a RAW copy for Capture One."
        />
      ) : (
        <div className="session-list">
          {jobs.map((job) => (
            <ExportCard key={job.id} job={job} onChanged={load} />
          ))}
        </div>
      )}
    </div>
  );
}
