"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchJson } from "@/lib/fetchJson";
import { SkeletonCards, EmptyState, Icons } from "./ui";
import ExportCard, { type ExportJob } from "./exports/ExportCard";
import PullToRefresh from "./PullToRefresh";

// Exports tab: browse the exports that were made and act on each one — download
// it (whole archive or file by file, via the expandable card) or delete it
// (erases the RAW copies from the export folder and reverts the assets to
// 'triaged'). Thumbnails reuse the source assets' derivatives.

export default function ExportsTab() {
  const [jobs, setJobs] = useState<ExportJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Companion preferences: when a keeper is half of a pair, also copy the other
  // half — the JPEG beside a RAW, the .mov motion beside a Live Photo still.
  // Persisted in app settings, and read back by the export modal's file picker
  // as ITS defaults (cf. exports/ExportFilePicker.tsx), so these two are the
  // standing answer and the picker is where you override it for one export.
  const [companions, setCompanions] = useState({ jpeg: false, liveVideo: false });

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
    fetchJson<{
      exportIncludeJpeg?: boolean;
      exportIncludeLiveVideo?: boolean;
    }>("/api/settings")
      .then((s) =>
        setCompanions({
          jpeg: Boolean(s.exportIncludeJpeg),
          liveVideo: Boolean(s.exportIncludeLiveVideo),
        }),
      )
      .catch(() => {});
  }, [load]);

  // One writer for both: the two preferences differ only in which key they set,
  // and a second hand-rolled copy is how exportIncludeLiveVideo ended up read
  // by the picker but written by nothing.
  const toggleCompanion = useCallback(
    async (which: "jpeg" | "liveVideo", next: boolean) => {
      setCompanions((c) => ({ ...c, [which]: next })); // optimistic
      const key =
        which === "jpeg" ? "exportIncludeJpeg" : "exportIncludeLiveVideo";
      try {
        const res = await fetch("/api/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [key]: next }),
        });
        if (!res.ok) throw new Error(String(res.status));
      } catch {
        setCompanions((c) => ({ ...c, [which]: !next })); // revert on failure
      }
    },
    [],
  );

  return (
    <>
      {/* The export preferences ride the shared toolbar band, flush under the
          Library header, above the scrolling job list. */}
      <div className="page-tools exports-toolbar">
        <label className="export-opt" title="When a picked photo is a RAW+JPEG pair, also copy the JPEG next to the RAW keeper.">
          <input
            type="checkbox"
            checked={companions.jpeg}
            onChange={(e) => toggleCompanion("jpeg", e.target.checked)}
          />
          <span>Include JPEG companion in exports</span>
        </label>
        <label
          className="export-opt"
          title="When a picked photo is a Live Photo, also copy its .mov motion next to the still keeper."
        >
          <input
            type="checkbox"
            checked={companions.liveVideo}
            onChange={(e) => toggleCompanion("liveVideo", e.target.checked)}
          />
          <span>Include Live Photo motion in exports</span>
        </label>
      </div>
      <PullToRefresh className="tab-pane sessions-pane" onRefresh={load}>
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
      </PullToRefresh>
    </>
  );
}
