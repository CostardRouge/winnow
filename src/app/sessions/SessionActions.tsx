"use client";

import { Icons } from "@/app/ui";
import DownloadMenu from "@/app/DownloadMenu";
import type { DownloadFile } from "@/lib/assetActions";

/**
 * The per-session action bar — one segmented control
 * (Complete · Ignore · Export Pics · Download · Delete) shared by the incoming
 * Sessions list and the session detail header so the two stay identical. Icons
 * carry the meaning; the text labels show on wider screens and collapse to
 * icon-only on small viewports and in the compact card layout (tooltips keep
 * every action discoverable). Stays on a single line in every layout.
 *
 * "Export Pics" copies the RAW picks to the Capture One folder server-side;
 * "Download" (the shared DownloadMenu) pulls *all* of the session's originals
 * down to the browser — ZIP, file-by-file or save-to-folder — without ever
 * running an export. The download segment only appears when `download` is given.
 */
export default function SessionActions({
  completed,
  ignored,
  canExport,
  onComplete,
  onIgnore,
  onExportPicks,
  onDelete,
  download,
  deleteTitle = "Remove this session (optionally delete its files from disk)",
}: {
  completed: boolean;
  ignored: boolean;
  /** Whether the session has any picks to export (disables the export segment). */
  canExport: boolean;
  onComplete: () => void;
  onIgnore: () => void;
  onExportPicks: () => void;
  onDelete: () => void;
  /** When provided, adds a Download segment for the session's original files. */
  download?: {
    zipHref: string;
    zipName: string;
    listFiles: () => Promise<DownloadFile[]>;
    onMessage?: (msg: string | null) => void;
  };
  /** Context-specific tooltip for the destructive (delete) segment. */
  deleteTitle?: string;
}) {
  return (
    <div className="seg-actions" role="group" aria-label="Session actions">
      <button
        className={`seg-btn${completed ? " is-on" : ""}`}
        onClick={onComplete}
        aria-label={completed ? "Mark as not complete" : "Mark complete"}
        title={completed ? "Mark as not complete" : "Mark complete"}
      >
        {Icons.keep}
        <span className="seg-label">{completed ? "Completed" : "Complete"}</span>
      </button>
      <button
        className="seg-btn"
        onClick={onIgnore}
        aria-label={ignored ? "Reactivate this session" : "Ignore this session"}
        title={ignored ? "Reactivate this session" : "Ignore this session"}
      >
        {ignored ? Icons.reset : Icons.skip}
        <span className="seg-label">{ignored ? "Reactivate" : "Ignore"}</span>
      </button>
      <button
        className="seg-btn"
        onClick={onExportPicks}
        disabled={!canExport}
        aria-label="Export picks"
        title={
          canExport
            ? "Export the RAW picks to the Capture One export folder"
            : "No picks to export yet"
        }
      >
        {Icons.upload}
        <span className="seg-label">Export Pics</span>
      </button>
      {download && (
        <DownloadMenu
          zipHref={download.zipHref}
          zipName={download.zipName}
          listFiles={download.listFiles}
          onMessage={download.onMessage}
          triggerClassName="seg-btn"
        />
      )}
      <button
        className="seg-btn is-danger"
        onClick={onDelete}
        aria-label="Delete session"
        title={deleteTitle}
      >
        {Icons.trash}
      </button>
    </div>
  );
}
