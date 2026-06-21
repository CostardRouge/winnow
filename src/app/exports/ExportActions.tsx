"use client";

import ActionMenu, { type MenuItem } from "@/app/ActionMenu";
import { Icons } from "@/app/ui";

/**
 * The per-export action bar — the same segmented control language as the
 * sessions list (SessionActions): a labelled Download segment (which drops the
 * existing ZIP / per-file / save-to-folder menu) joined to an icon-only Delete.
 * The download menu items + busy state are owned by the card and passed through
 * untouched, so downloads behave exactly as before.
 */
export default function ExportActions({
  downloadItems,
  downloadBusy,
  canDownload,
  onDelete,
  deleteBusy,
}: {
  downloadItems: MenuItem[];
  downloadBusy: boolean;
  /** Hide the Download segment when the export has no files. */
  canDownload: boolean;
  onDelete: () => void;
  deleteBusy: boolean;
}) {
  return (
    <div className="seg-actions" role="group" aria-label="Export actions">
      {canDownload && (
        <ActionMenu
          ariaLabel="Download options"
          label="Download"
          items={downloadItems}
          disabled={downloadBusy}
          trigger={{
            label: downloadBusy ? "Downloading…" : "Download",
            icon: Icons.download,
            className: "seg-btn",
          }}
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
