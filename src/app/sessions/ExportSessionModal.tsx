"use client";

import { useEffect, useState } from "react";
import { fetchJson } from "@/lib/fetchJson";
import { deleteAssetsByFilter } from "@/lib/assetActions";

// Custom, reusable export modal for a session — replaces the old browser
// prompt()/alert() flow. It drives the same POST /api/export (RAW copy of the
// picks to the Capture One export folder) but adds:
//   - a proper export-name field;
//   - companion-file choices, shown only when the session actually has them:
//       · RAW+JPEG pairs (Sony .ARW+.HIF …) → keep both, the JPEG/HIF only, or
//         the RAW only (raw_jpeg_mode);
//       · iPhone Live Photos → optionally carry the .mov motion;
//   - post-export cleanup, so the whole "export then tidy up" gesture is one
//     step: mark the session ignored (treated), and/or move its rejects and its
//     still-unrated media to the trash (soft-delete, recoverable).
// Shared by the incoming Sessions list and the session detail header.

export type ExportableSession = {
  id: number;
  name: string;
  pick_count: number;
  reject_count: number;
  unrated_count: number;
  /** RAW+JPEG pairs in the session (0 hides the RAW+JPEG choice). */
  raw_jpeg_pairs: number;
  /** iPhone Live Photo pairs (0 hides the Live Photo choice). */
  live_photo_pairs: number;
};

type RawJpegMode = "both" | "jpeg" | "raw";

const RAW_JPEG_CHOICES: Array<{
  value: RawJpegMode;
  label: string;
  hint: string;
}> = [
  { value: "both", label: "RAW + JPEG/HIF", hint: "Copy both files of each pair" },
  { value: "jpeg", label: "JPEG/HIF only", hint: "Skip the RAW, keep the light file" },
  { value: "raw", label: "RAW only", hint: "Skip the direct JPEG/HIF companion" },
];

export default function ExportSessionModal({
  session,
  onClose,
  onSubmitted,
}: {
  session: ExportableSession;
  onClose: () => void;
  /** Called after the job is queued (and cleanup applied) with a summary toast. */
  onSubmitted: (message: string) => void;
}) {
  const [name, setName] = useState(`${session.name}-picks`);
  const [ignoreAfter, setIgnoreAfter] = useState(false);
  const [trashRejects, setTrashRejects] = useState(false);
  const [trashUnrated, setTrashUnrated] = useState(false);
  const [rawJpegMode, setRawJpegMode] = useState<RawJpegMode>("raw");
  const [includeLiveVideo, setIncludeLiveVideo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasRawJpeg = session.raw_jpeg_pairs > 0;
  const hasLivePhoto = session.live_photo_pairs > 0;
  const rejectCount = Number(session.reject_count) || 0;
  const unratedCount = Number(session.unrated_count) || 0;

  // Seed the companion defaults from the persisted export preferences, so the
  // modal opens on whatever the user usually picks.
  useEffect(() => {
    let alive = true;
    fetchJson<{ exportIncludeJpeg?: boolean; exportIncludeLiveVideo?: boolean }>(
      "/api/settings",
    )
      .then((s) => {
        if (!alive) return;
        setRawJpegMode(s.exportIncludeJpeg ? "both" : "raw");
        setIncludeLiveVideo(Boolean(s.exportIncludeLiveVideo));
      })
      .catch(() => {
        /* keep the safe defaults (raw only / no live video) */
      });
    return () => {
      alive = false;
    };
  }, []);

  // Close on Escape (unless a request is in flight).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Give the export a name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const params: Record<string, unknown> = {};
      if (hasRawJpeg) params.raw_jpeg_mode = rawJpegMode;
      if (hasLivePhoto) params.include_live_video = includeLiveVideo;

      const r = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmed,
          target: "capture_one",
          filter: { session_id: session.id, verdict: "pick" },
          params,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.export_job_id) {
        throw new Error(data.error ?? "Couldn’t queue the export.");
      }

      // Post-export cleanup — soft-delete first (recoverable), then ignore.
      let trashed = 0;
      if (trashRejects) {
        trashed += await deleteAssetsByFilter({
          session_id: session.id,
          verdict: "reject",
        });
      }
      if (trashUnrated) {
        trashed += await deleteAssetsByFilter({
          session_id: session.id,
          verdict: "unrated",
        });
      }
      if (ignoreAfter) {
        await fetch(`/api/sessions/${session.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ignored: true }),
        });
      }

      const bits = [`Export #${data.export_job_id} queued`];
      if (trashed > 0) bits.push(`${trashed} moved to trash`);
      if (ignoreAfter) bits.push("session ignored");
      onSubmitted(`${bits.join(" · ")}. Run the worker to copy the RAW files.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Export session"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title">Export “{session.name}”</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          Copies the {session.pick_count} RAW pick(s) to the Capture One export
          folder. The originals are never touched.
        </p>

        <label className="modal-label" htmlFor="export-name">
          Export name
        </label>
        <input
          id="export-name"
          className="input"
          type="text"
          value={name}
          autoFocus
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !busy) submit();
          }}
        />

        {(hasRawJpeg || hasLivePhoto) && (
          <>
            {hasRawJpeg && (
              <>
                <label className="modal-label">
                  RAW + JPEG/HIF pairs ({session.raw_jpeg_pairs})
                </label>
                <div className="type-choices">
                  {RAW_JPEG_CHOICES.map((c) => (
                    <label
                      key={c.value}
                      className={`type-choice${rawJpegMode === c.value ? " active" : ""}`}
                    >
                      <input
                        type="radio"
                        name="raw-jpeg-mode"
                        value={c.value}
                        checked={rawJpegMode === c.value}
                        disabled={busy}
                        onChange={() => setRawJpegMode(c.value)}
                      />
                      <span className="type-choice-label">{c.label}</span>
                      <span className="type-choice-hint">{c.hint}</span>
                    </label>
                  ))}
                </div>
              </>
            )}

            {hasLivePhoto && (
              <label className="export-check">
                <input
                  type="checkbox"
                  checked={includeLiveVideo}
                  disabled={busy}
                  onChange={(e) => setIncludeLiveVideo(e.target.checked)}
                />
                <span>
                  <strong>Include the Live Photo video (.mov)</strong>
                  <span className="hint" style={{ display: "block" }}>
                    Carry the motion clip next to the still for the{" "}
                    {session.live_photo_pairs} Live Photo(s).
                  </span>
                </span>
              </label>
            )}
          </>
        )}

        <label className="modal-label">After exporting</label>
        <label className="export-check">
          <input
            type="checkbox"
            checked={ignoreAfter}
            disabled={busy}
            onChange={(e) => setIgnoreAfter(e.target.checked)}
          />
          <span>
            <strong>Ignore this session</strong>
            <span className="hint" style={{ display: "block" }}>
              Marks it as treated and hides it from the incoming list. Reversible.
            </span>
          </span>
        </label>

        <label
          className={`export-check${rejectCount === 0 ? " is-disabled" : ""}`}
        >
          <input
            type="checkbox"
            checked={trashRejects}
            disabled={busy || rejectCount === 0}
            onChange={(e) => setTrashRejects(e.target.checked)}
          />
          <span>
            <strong>Move rejects to the trash ({rejectCount})</strong>
            <span className="hint" style={{ display: "block" }}>
              Soft-delete every rejected shot. Recoverable until you empty the
              trash.
            </span>
          </span>
        </label>

        <label
          className={`export-check${unratedCount === 0 ? " is-disabled" : ""}`}
        >
          <input
            type="checkbox"
            checked={trashUnrated}
            disabled={busy || unratedCount === 0}
            onChange={(e) => setTrashUnrated(e.target.checked)}
          />
          <span>
            <strong>Move unrated to the trash ({unratedCount})</strong>
            <span className="hint" style={{ display: "block" }}>
              Bin the still-unsorted media too. Recoverable until you empty the
              trash.
            </span>
          </span>
        </label>

        {error && <p className="modal-warn">{error}</p>}

        <div className="modal-actions">
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? "Exporting…" : "Export picks"}
          </button>
        </div>
      </div>
    </div>
  );
}
