"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { fetchJson } from "@/lib/fetchJson";
import { formatBytes } from "@/lib/format";
import {
  EXPORT_CATEGORIES,
  EXPORT_CATEGORY_META,
  EXPORT_SECTIONS,
  type ExportCategory,
  type ExportPlan,
} from "@/lib/exportTypes";

// The export modal's dynamic "files to include" picker. On mount it scans the
// selection (POST /api/export/plan) and renders ONE checkbox row per file
// category the selection actually holds — with the real extensions, counts and
// cumulated size — grouped in three sections (Originals / Companions /
// Telemetry & metadata). Nothing is hardcoded to "RAW picks": a video-only
// drone session shows Videos + Drone flight logs, an iPhone session shows
// Photos + Live Photo motion, etc. Empty rows and empty sections don't render.
//
// Defaults: originals and sidecars checked; the pair-JPEG and Live-motion
// companions follow the persisted export preferences, like the old modal did.

export type ExportPickerState = {
  /** Per-category selection to send as the export's `include`. */
  include: Record<ExportCategory, boolean>;
  /** Files/bytes currently checked — drives the "Export N files" button. */
  files: number;
  bytes: number;
  /** False until the scan resolves (submit should wait). */
  loaded: boolean;
};

export default function ExportFilePicker({
  filter,
  disabled = false,
  onChange,
}: {
  /** Same shape as POST /api/export's `filter` (ids, session_id+verdict…). */
  filter: Record<string, unknown>;
  disabled?: boolean;
  onChange: (state: ExportPickerState) => void;
}) {
  const [plan, setPlan] = useState<ExportPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [include, setInclude] = useState<Record<ExportCategory, boolean>>({
    raw: true,
    photo: true,
    video: true,
    pair_jpeg: false,
    live_motion: false,
    sidecar_srt: true,
    sidecar_meta: true,
  });
  // The parent's callback, kept fresh without re-running the scan effect.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const filterKey = JSON.stringify(filter);

  // Scan the selection + seed the companion defaults from the persisted export
  // preferences, in parallel. A failed settings read keeps the safe defaults.
  useEffect(() => {
    let alive = true;
    setPlan(null);
    setError(null);
    Promise.all([
      fetchJson<ExportPlan>("/api/export/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: `{"filter":${filterKey}}`,
      }),
      fetchJson<{
        exportIncludeJpeg?: boolean;
        exportIncludeLiveVideo?: boolean;
      }>("/api/settings").catch(() => ({}) as Record<string, never>),
    ])
      .then(([p, s]) => {
        if (!alive) return;
        setInclude((prev) => ({
          ...prev,
          pair_jpeg: Boolean(s.exportIncludeJpeg),
          live_motion: Boolean(s.exportIncludeLiveVideo),
        }));
        setPlan(p);
      })
      .catch((e) => {
        if (alive) setError((e as Error).message);
      });
    return () => {
      alive = false;
    };
  }, [filterKey]);

  const groups = useMemo(() => {
    const byCat = new Map(plan?.groups.map((g) => [g.category, g]) ?? []);
    // Fixed taxonomy order, dynamic presence.
    return EXPORT_CATEGORIES.map((c) => byCat.get(c)).filter(
      (g): g is NonNullable<typeof g> => Boolean(g && g.count > 0),
    );
  }, [plan]);

  // Report every selection change (and the initial scan) upward.
  useEffect(() => {
    const checked = groups.filter((g) => include[g.category]);
    onChangeRef.current({
      include,
      files: checked.reduce((n, g) => n + g.count, 0),
      bytes: checked.reduce((n, g) => n + g.bytes, 0),
      loaded: plan != null,
    });
  }, [groups, include, plan]);

  if (error)
    return (
      <p className="modal-warn">
        Couldn’t scan the selection’s files: {error}
      </p>
    );

  if (!plan)
    return (
      <div className="picker-scanning hint" aria-live="polite">
        Scanning files…
      </div>
    );

  if (groups.length === 0)
    return <p className="modal-warn">Nothing to export in this selection.</p>;

  return (
    <div className="export-picker">
      {EXPORT_SECTIONS.map((section) => {
        const rows = groups.filter(
          (g) => EXPORT_CATEGORY_META[g.category].section === section,
        );
        if (!rows.length) return null;
        return (
          <div key={section} className="picker-section">
            <div className="picker-section-label">{section}</div>
            {rows.map((g) => {
              const meta = EXPORT_CATEGORY_META[g.category];
              return (
                <label key={g.category} className="export-check picker-row">
                  <input
                    type="checkbox"
                    checked={include[g.category]}
                    disabled={disabled}
                    onChange={(e) =>
                      setInclude((prev) => ({
                        ...prev,
                        [g.category]: e.target.checked,
                      }))
                    }
                  />
                  <span className="picker-row-main">
                    <strong>{meta.label}</strong>
                    <span className="hint picker-row-hint">{meta.hint}</span>
                  </span>
                  <span className="picker-row-facts">
                    <span className="picker-chips">
                      {g.exts.map((e) => (
                        <span key={e.ext} className="ext-chip">
                          {e.ext} ×{e.count}
                        </span>
                      ))}
                    </span>
                    <span className="picker-bytes">{formatBytes(g.bytes)}</span>
                  </span>
                </label>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
