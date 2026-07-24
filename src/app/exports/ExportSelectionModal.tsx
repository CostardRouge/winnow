"use client";

import { useEffect, useState } from "react";
import { formatBytes } from "@/lib/format";
import ExportFilePicker, {
  type ExportPickerState,
} from "./ExportFilePicker";

// Export modal for an ad-hoc selection (gallery bulk bar, context menu, map
// area). The gallery used to fire POST /api/export silently, with no options;
// now it gets the same dynamic "files to include" picker as the session modal
// — scan the selected ids, one checkbox per file category actually present —
// minus the session-only extras (cleanup, pick counts).

export default function ExportSelectionModal({
  ids,
  onClose,
  onSubmitted,
}: {
  ids: number[];
  onClose: () => void;
  /** Called once the job is queued, with a summary toast. */
  onSubmitted: (message: string) => void;
}) {
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const [name, setName] = useState(
    ids.length === 1 ? `Export ${stamp}` : `Selection ${ids.length} · ${stamp}`,
  );
  const [picker, setPicker] = useState<ExportPickerState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
          filter: { ids },
          include: picker.include,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.export_job_id) {
        throw new Error(data.error ?? "Couldn’t queue the export.");
      }
      onSubmitted(`Export #${data.export_job_id} queued (${picker.files} file(s))`);
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
        aria-label="Export selection"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title">
          Export {ids.length === 1 ? "1 media" : `${ids.length} media`}
        </h2>
        <p className="hint" style={{ marginTop: 0 }}>
          Copies the selection’s files to the export folder —{" "}
          {picker?.loaded
            ? `${picker.files} file(s) · ${formatBytes(picker.bytes)} selected`
            : "scanning the selection"}
          . The originals are never touched.
        </p>

        <label className="modal-label" htmlFor="export-sel-name">
          Export name
        </label>
        <input
          id="export-sel-name"
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
          filter={{ ids }}
          disabled={busy}
          onChange={setPicker}
        />

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
