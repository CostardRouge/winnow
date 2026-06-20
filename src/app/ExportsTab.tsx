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
