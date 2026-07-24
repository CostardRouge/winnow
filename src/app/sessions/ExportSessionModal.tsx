"use client";

import { useEffect, useState } from "react";
import { deleteAssetsByFilter } from "@/lib/assetActions";
import { formatBytes } from "@/lib/format";
import ExportFilePicker, {
  type ExportPickerState,
} from "@/app/exports/ExportFilePicker";

// Custom, reusable export modal for a session — replaces the old browser
// prompt()/alert() flow. It drives the same POST /api/export (copy of the
// picks' originals to the export folder) but adds:
//   - a proper export-name field;
//   - a dynamic "files to include" picker (ExportFilePicker): the session's
//     picks are scanned and one checkbox per file category actually present is
//     shown — RAW / photos / videos / pair JPEG / Live Photo motion / drone
//     SRT telemetry / camera XML+THM — with real extensions, counts and sizes;
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
  // What the file picker currently has checked (per-category include + live
  // file/byte totals). Null until its scan resolves.
  const [picker, setPicker] = useState<ExportPickerState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rejectCount = Number(session.reject_count) || 0;
  const unratedCount = Number(session.unrated_count) || 0;

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
    if (!picker?.loaded || picker.files === 0) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmed,
          target: "capture_one",
          filter: { session_id: session.id, verdict: "pick" },
          include: picker.include,
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
      onSubmitted(`${bits.join(" · ")}. Run the worker to copy the files.`);
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
          Copies the files of the {session.pick_count} pick(s) to the export
          folder — {picker?.loaded
            ? `${picker.files} file(s) · ${formatBytes(picker.bytes)} selected`
            : "scanning the selection"}
          . The originals are never touched.
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

        <label className="modal-label">Files to include</label>
        <ExportFilePicker
          filter={{ session_id: session.id, verdict: "pick" }}
          disabled={busy}
          onChange={setPicker}
        />

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
          <button
            className="btn btn-primary"
            onClick={submit}
            disabled={busy || !picker?.loaded || picker.files === 0}
          >
            {busy
              ? "Exporting…"
              : picker?.loaded
                ? `Export ${picker.files} file(s)`
                : "Export"}
          </button>
        </div>
      </div>
    </div>
  );
}
