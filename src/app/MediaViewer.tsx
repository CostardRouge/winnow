"use client";

// Reusable full-screen media viewer (the dark lightbox). Extracted from the
// gallery so any surface — the cull grid, the Exports library, anywhere — can
// show a photo/video at full size with the same chrome, keyboard navigation and
// metadata panel.
//
// It owns only what is universal: rendering the current media, prev/next
// navigation (buttons + arrow keys), Escape-to-close and the metadata panel.
// Everything contextual (rating controls, tag editing, a download button…) is
// injected by the caller through `renderActions` / `renderInfo`, and extra
// shortcuts through `onKeyDown`. Media URLs default to the asset derivatives but
// can be overridden (e.g. an export item keyed by its source asset).
import { useEffect, type ReactNode } from "react";
import AssetMeta, { type AssetMetaInput } from "./gallery/AssetMeta";

export type ViewerItem = AssetMetaInput & {
  id: number;
  filename: string;
  media_type?: "photo" | "video";
  derivative_status?: string;
};

export default function MediaViewer<T extends ViewerItem>({
  items,
  index,
  onIndexChange,
  onClose,
  mediaSrc = (it) => `/api/assets/${it.id}/proxy`,
  posterSrc = (it) => `/api/assets/${it.id}/thumb`,
  renderInfo,
  renderActions,
  onKeyDown,
  onContextMenu,
}: {
  items: T[];
  index: number;
  onIndexChange: (i: number) => void;
  onClose: () => void;
  /** Source for the large media (default: the asset's proxy). */
  mediaSrc?: (item: T) => string;
  /** Poster for videos (default: the asset's thumbnail). */
  posterSrc?: (item: T) => string;
  /** Extra block under the metadata (e.g. tags). */
  renderInfo?: (item: T) => ReactNode;
  /** Buttons placed between prev/next in the controls bar. */
  renderActions?: (item: T) => ReactNode;
  /** Extra key handling (e.g. rating shortcuts); skipped while typing. */
  onKeyDown?: (e: KeyboardEvent, item: T) => void;
  onContextMenu?: (e: React.MouseEvent, item: T) => void;
}) {
  const last = items.length - 1;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const it = items[index];
      if (!it) return;
      // Don't hijack keys while the user is typing in a field (e.g. a tag input).
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "Escape") return onClose();
      if (e.key === "ArrowRight") return onIndexChange(Math.min(index + 1, last));
      if (e.key === "ArrowLeft") return onIndexChange(Math.max(index - 1, 0));
      onKeyDown?.(e, it);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, index, last, onIndexChange, onClose, onKeyDown]);

  const item = items[index];
  if (!item) return null;

  // Items that don't carry a derivative_status (e.g. always-ready exports) are
  // assumed displayable; otherwise we only show it once the derivative is ready.
  const ready = item.derivative_status ? item.derivative_status === "ready" : true;

  return (
    <div className="viewer">
      <button className="close" onClick={onClose} aria-label="Close viewer">
        ×
      </button>
      <div className="exif">
        <strong>{item.filename}</strong>
        <AssetMeta asset={item} />
        {renderInfo?.(item)}
      </div>
      <div
        className="stage"
        onContextMenu={onContextMenu ? (e) => onContextMenu(e, item) : undefined}
      >
        {ready ? (
          item.media_type === "video" ? (
            <video
              key={item.id}
              src={mediaSrc(item)}
              poster={posterSrc(item)}
              controls
              playsInline
              autoPlay
              muted
              loop
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={mediaSrc(item)} alt={item.filename} />
          )
        ) : (
          <div className="placeholder">Derivative unavailable</div>
        )}
      </div>
      <div className="controls">
        <button
          className="btn"
          onClick={() => onIndexChange(Math.max(index - 1, 0))}
          disabled={index === 0}
          aria-label="Previous"
        >
          ←
        </button>
        {renderActions?.(item)}
        <button
          className="btn"
          onClick={() => onIndexChange(Math.min(index + 1, last))}
          disabled={index === last}
          aria-label="Next"
        >
          →
        </button>
      </div>
    </div>
  );
}
