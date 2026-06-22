"use client";

import DownloadMenu from "@/app/DownloadMenu";
import { Icons } from "@/app/ui";
import type { DownloadFile } from "@/lib/assetActions";

/**
 * The per-export action bar — the same segmented control language as the
 * sessions list (SessionActions): a labelled Download segment (the shared
 * DownloadMenu: ZIP / each file / save-to-folder) joined to an icon-only Delete.
 * The download source is the export's copied output; the menu itself is shared
 * with the session media download, which points it at the originals instead.
 */
export default function ExportActions({
  zipHref,
  zipName,
  listFiles,
  canDownload,
  onMessage,
  onDelete,
  deleteBusy,
}: {
  /** URL streaming the whole export as one ZIP. */
  zipHref: string;
  /** Suggested ZIP filename. */
  zipName: string;
  /** Lazily resolve the export's downloadable files. */
  listFiles: () => Promise<DownloadFile[]>;
  /** Hide the Download segment when the export has no files. */
  canDownload: boolean;
  /** Surface transient download status to the card. */
  onMessage?: (msg: string | null) => void;
  onDelete: () => void;
  deleteBusy: boolean;
}) {
  return (
    <div className="seg-actions" role="group" aria-label="Export actions">
      {canDownload && (
        <DownloadMenu
          zipHref={zipHref}
          zipName={zipName}
          listFiles={listFiles}
          onMessage={onMessage}
          triggerClassName="seg-btn"
        />
      )}
      <button
        className="seg-btn is-danger"
        onClick={onDelete}
        disabled={deleteBusy}
        aria-label="Delete export"
        title="Delete this export (removes the copied files from the export folder)"
      >
        {deleteBusy ? "…" : Icons.trash}
      </button>
    </div>
  );
}
