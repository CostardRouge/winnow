"use client";

import { useState } from "react";

// Confirmation modal for deleting a session. A checkbox opts into the
// irreversible filesystem delete (off by default, since the DB-only delete is
// recoverable by re-scanning the folder, whereas wiping the originals is not).
// Shared by the sessions list (SessionsPane) and the session detail page.

export type DeletableSession = {
  name: string;
  asset_count: number;
  pick_count: number;
};

export default function DeleteSessionModal({
  session,
  onClose,
  onConfirm,
}: {
  session: DeletableSession;
  onClose: () => void;
  onConfirm: (withFiles: boolean) => Promise<void>;
}) {
  const [withFiles, setWithFiles] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(withFiles);
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
        aria-label="Delete session"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title">Delete “{session.name}”?</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          Removes the session, its {session.asset_count} indexed media and their
          ratings
          {session.pick_count > 0 ? ` (incl. ${session.pick_count} pick(s))` : ""}{" "}
          from the database, plus their cached thumbnails/proxies. You can re-add
          the folder later to re-index it.
        </p>

        <label
          style={{
            display: "flex",
            gap: 10,
            alignItems: "flex-start",
            marginTop: 14,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={withFiles}
            onChange={(e) => setWithFiles(e.target.checked)}
            style={{ marginTop: 3 }}
          />
          <span>
            <strong>Also delete the original files from disk</strong>
            <span className="hint" style={{ display: "block" }}>
              Permanently removes the {session.asset_count} file(s) and the empty
              folder from the filesystem. This is irreversible — leave unchecked
              to keep the originals.
            </span>
          </span>
        </label>

        {withFiles && (
          <p className="modal-warn">
            The {session.asset_count} original file(s) will be permanently
            deleted from disk and cannot be recovered.
          </p>
        )}
        {error && <p className="modal-warn">{error}</p>}

        <div className="modal-actions">
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-danger" onClick={submit} disabled={busy}>
            {busy
              ? "Deleting…"
              : withFiles
                ? `Delete session + ${session.asset_count} file(s)`
                : "Delete session"}
          </button>
        </div>
      </div>
    </div>
  );
}
