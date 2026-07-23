"use client";

import { useState } from "react";

// Shared bulk-action toolbar shown while selecting assets in a grid (the library
// gallery + the session detail). It owns only the tag-name input; the selection
// itself and every action handler live in the host so each surface keeps its own
// optimistic state. This is the many-asset mirror of the per-asset context menu
// and the in-viewer ViewerActions, kept in one place so the three stay in step.
export default function BulkActionBar({
  count,
  onSelectAll,
  onClear,
  onPick,
  onReject,
  onStar,
  onTag,
  onExport,
  onRegenerate,
  onGeocode,
  onGeotag,
  onMl,
  onDelete,
}: {
  /** How many assets are currently selected. */
  count: number;
  /** Select every asset loaded into the grid. */
  onSelectAll: () => void;
  /** Drop the current selection (stays in select mode). */
  onClear: () => void;
  onPick: () => void;
  onReject: () => void;
  onStar: (n: number) => void;
  /** Add (`add`) or remove a tag by name across the selection. */
  onTag: (name: string, add: boolean) => void;
  onExport: () => void;
  onRegenerate: () => void;
  /** Resolve the GPS coordinates of the selection to place names. */
  onGeocode: () => void;
  /** Manually set the GPS position of the selection (picker + recap flow).
   * Omitted when the host surface doesn't offer it. */
  onGeotag?: () => void;
  /** (Re)run the ML analysis (faces + OCR) on the selection. Omitted when the
   * host surface doesn't offer it. */
  onMl?: () => void;
  onDelete: () => void;
}) {
  const [tagInput, setTagInput] = useState("");
  const none = count === 0;
  const noTag = none || !tagInput.trim();

  return (
    <div className="selectbar">
      <span className="hint">{count} selected</span>
      <button className="btn" onClick={onSelectAll}>
        Select all loaded
      </button>
      <button className="btn" onClick={onClear}>
        Clear
      </button>
      <span className="ctx-sep-v" />
      <button className="btn btn-pick" disabled={none} onClick={onPick}>
        ✓ Pick
      </button>
      <button className="btn btn-reject" disabled={none} onClick={onReject}>
        ✕ Reject
      </button>
      <span className="bulk-stars" role="group" aria-label="Rate selection">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            className="btn bulk-star"
            disabled={none}
            title={`${n} star${n > 1 ? "s" : ""}`}
            onClick={() => onStar(n)}
          >
            ★
          </button>
        ))}
      </span>
      <span className="spacer" />
      <input
        className="input"
        placeholder="tag name"
        value={tagInput}
        onChange={(e) => setTagInput(e.target.value)}
        style={{ minWidth: 120 }}
      />
      <button
        className="btn"
        disabled={noTag}
        onClick={() => onTag(tagInput, true)}
      >
        + Tag
      </button>
      <button
        className="btn"
        disabled={noTag}
        onClick={() => onTag(tagInput, false)}
      >
        − Tag
      </button>
      <span className="ctx-sep-v" />
      <button className="btn" disabled={none} onClick={onExport}>
        ⤓ Export
      </button>
      <button
        className="btn"
        disabled={none}
        title="Rebuild thumbnail + proxy"
        onClick={onRegenerate}
      >
        ↻ Regenerate
      </button>
      <button
        className="btn"
        disabled={none}
        title="Resolve GPS coordinates to place names"
        onClick={onGeocode}
      >
        📍 Locate
      </button>
      {onGeotag && (
        <button
          className="btn"
          disabled={none}
          title="Set the capture location (search, map pick) with a before/after recap"
          onClick={onGeotag}
        >
          📌 Geotag
        </button>
      )}
      {onMl && (
        <button
          className="btn"
          disabled={none}
          title="Detect faces and read the text in the image"
          onClick={onMl}
        >
          ☻ Faces
        </button>
      )}
      <button className="btn btn-reject" disabled={none} onClick={onDelete}>
        🗑 Delete
      </button>
    </div>
  );
}
