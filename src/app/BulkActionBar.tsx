"use client";

import { useEffect, useRef, useState } from "react";
import ActionMenu, { type MenuItem } from "./ActionMenu";
import DownloadMenu from "./DownloadMenu";
import type { DownloadFile } from "@/lib/assetActions";

// Shared bulk-action toolbar shown while selecting assets in a grid (the library
// gallery + the session detail). It floats fixed at the bottom of the viewport
// so the actions stay reachable however far the grid has scrolled — selecting
// deep in the library no longer means scrolling back up to act on it. Hosts add
// .has-bulk-bar to their scroll zone while it's up so the last rows can rise
// above the bar. Frequent actions (verdicts, stars, tag, export, download) ride
// the bar itself; maintenance and destructive ones live behind the ⋯ menu. The
// bar owns only its own popovers; the selection and every action handler live
// in the host so each surface keeps its own optimistic state. This is the
// many-asset mirror of the per-asset context menu and the in-viewer
// ViewerActions, kept in one place so the three stay in step.
export default function BulkActionBar({
  count,
  onSelectAll,
  onClear,
  onPick,
  onReject,
  onStar,
  onTag,
  onExport,
  download,
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
  /** Pull the selection's original files down (the shared DownloadMenu: ZIP /
   * each file / save-to-folder). Omitted when the host doesn't offer it. */
  download?: {
    zipHref: string;
    zipName: string;
    listFiles: () => Promise<DownloadFile[]>;
    onMessage?: (msg: string | null) => void;
  };
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
  const [tagOpen, setTagOpen] = useState(false);
  const tagRef = useRef<HTMLSpanElement>(null);
  const none = count === 0;
  const noTag = none || !tagInput.trim();

  // The tag popover dismisses like every other transient surface here:
  // click-away or Escape. The input's value survives so re-opening to tag the
  // next batch with the same name is one click.
  useEffect(() => {
    if (!tagOpen) return;
    const onDown = (e: MouseEvent) => {
      if (tagRef.current?.contains(e.target as Node)) return;
      setTagOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTagOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [tagOpen]);

  const tag = (add: boolean) => {
    if (!tagInput.trim()) return;
    onTag(tagInput, add);
    setTagOpen(false);
  };

  // Occasional maintenance + the destructive tail, folded behind one ⋯ so the
  // bar stays a single readable row. Glyphs mirror the per-asset context menu.
  const more: MenuItem[] = [
    {
      key: "regenerate",
      label: "Regenerate derivatives",
      hint: "Rebuild thumbnail + proxy",
      icon: "↻",
      disabled: none,
      onSelect: onRegenerate,
    },
    {
      key: "geocode",
      label: "Resolve location",
      hint: "GPS → place names",
      icon: "📍",
      disabled: none,
      onSelect: onGeocode,
    },
    ...(onGeotag
      ? [
          {
            key: "geotag",
            label: "Set location…",
            hint: "Search or pick on a map",
            icon: "📌",
            disabled: none,
            onSelect: onGeotag,
          } as MenuItem,
        ]
      : []),
    ...(onMl
      ? [
          {
            key: "ml",
            label: "Detect faces & text",
            icon: "☻",
            disabled: none,
            onSelect: onMl,
          } as MenuItem,
        ]
      : []),
    {
      key: "delete",
      label: "Delete…",
      icon: "🗑",
      danger: true,
      disabled: none,
      onSelect: onDelete,
    },
  ];

  return (
    <div className="bulk-bar" role="toolbar" aria-label="Selection actions">
      <span className="bulk-count" aria-live="polite">
        <span className={`bulk-count-num${none ? "" : " has"}`}>{count}</span>
        <span className="bulk-label">selected</span>
      </span>
      <button className="btn" onClick={onSelectAll} title="Select every loaded asset">
        All
      </button>
      <button className="btn" disabled={none} onClick={onClear} title="Drop the selection">
        None
      </button>
      <span className="ctx-sep-v" aria-hidden />
      <button className="btn btn-pick" disabled={none} onClick={onPick}>
        ✓<span className="bulk-label">Pick</span>
      </button>
      <button className="btn btn-reject" disabled={none} onClick={onReject}>
        ✕<span className="bulk-label">Reject</span>
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
      <span className="ctx-sep-v" aria-hidden />
      <span className="bulk-tag-wrap" ref={tagRef}>
        <button
          className={`btn${tagOpen ? " is-open" : ""}`}
          disabled={none}
          aria-haspopup="true"
          aria-expanded={tagOpen}
          title="Add or remove a tag across the selection"
          onClick={() => setTagOpen((o) => !o)}
        >
          #<span className="bulk-label">Tag</span>
        </button>
        {tagOpen && (
          <form
            className="bulk-tag-pop"
            onSubmit={(e) => {
              e.preventDefault();
              tag(true);
            }}
          >
            <input
              autoFocus
              className="input"
              placeholder="tag name"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
            />
            <button type="submit" className="btn" disabled={noTag}>
              + Add
            </button>
            <button
              type="button"
              className="btn"
              disabled={noTag}
              onClick={() => tag(false)}
            >
              − Remove
            </button>
          </form>
        )}
      </span>
      <button className="btn" disabled={none} onClick={onExport}>
        ⤓<span className="bulk-label">Export</span>
      </button>
      {download && (
        <DownloadMenu
          zipHref={download.zipHref}
          zipName={download.zipName}
          listFiles={download.listFiles}
          onMessage={download.onMessage}
          triggerClassName="btn"
          disabled={none}
        />
      )}
      <ActionMenu ariaLabel="More selection actions" items={more} disabled={none} />
    </div>
  );
}
