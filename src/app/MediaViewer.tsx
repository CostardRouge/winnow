"use client";

// Reusable full-screen media viewer (the dark lightbox). Extracted from the
// gallery so any surface — the cull grid, the Exports library, anywhere — can
// show a photo/video at full size with the same chrome, keyboard navigation and
// metadata panel.
//
// It owns only what is universal: rendering the current media, prev/next
// navigation (buttons + arrow keys + touch swipe), pinch/trackpad zoom,
// Escape-to-close and the (toggleable) metadata bottom panel. Everything
// contextual (rating controls, tag editing, a download button…) is injected by
// the caller through `renderActions` / `renderInfo`, and extra shortcuts through
// `onKeyDown`. Media URLs default to the asset derivatives but can be overridden
// (e.g. an export item keyed by its source asset).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import AssetMeta, { type AssetMetaInput } from "./gallery/AssetMeta";

export type ViewerItem = AssetMetaInput & {
  id: number;
  filename: string;
  media_type?: "photo" | "video";
  derivative_status?: string;
  // RAW+JPEG pairing (cf. lib/pairing.ts). When the item has a companion, the
  // viewer offers a segmented toggle to swap the displayed source between this
  // file (the JPEG/HEIF primary) and its RAW companion. `ext`/`companion_ext`
  // label the two segments.
  ext?: string;
  companion_id?: number | null;
  companion_ext?: string | null;
};

// "jpg"/"DNG" segment label from an extension (".jpg" → "JPG").
const fmtExt = (ext?: string | null) =>
  (ext ?? "").replace(".", "").toUpperCase();

const MIN_SCALE = 1;
const MAX_SCALE = 6;
const SWIPE_THRESHOLD = 50; // px a one-finger drag must travel to count as a swipe

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

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

  // Metadata bottom panel: shown by default, toggleable down to a small info
  // icon so it never has to cover the media.
  const [panelOpen, setPanelOpen] = useState(true);

  // RAW+JPEG pairing: which side of the pair is displayed. Resets to the primary
  // (JPEG/HEIF) whenever we move to another item.
  const [showCompanion, setShowCompanion] = useState(false);

  // Zoom/pan transform applied to the current media. Reset whenever we move to
  // another item so each photo/video starts fitted.
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setScale(1);
    setTx(0);
    setTy(0);
    setShowCompanion(false);
  }, [index]);

  // Once back to fit, drop any leftover pan so the media re-centres.
  useEffect(() => {
    if (scale <= MIN_SCALE) {
      setTx(0);
      setTy(0);
    }
  }, [scale]);

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

  // Trackpad pinch (and ctrl+wheel) zoom. Attached natively so we can call
  // preventDefault — React's onWheel is passive and would let the page zoom.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return; // browsers flag trackpad pinch as ctrl+wheel
      e.preventDefault();
      setScale((s) => clamp(s - e.deltaY * 0.01, MIN_SCALE, MAX_SCALE));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Touch gesture bookkeeping: a single ref tracks whichever gesture is live.
  const touch = useRef({
    mode: "none" as "none" | "pinch" | "pan" | "swipe",
    startDist: 0,
    startScale: 1,
    startX: 0,
    startY: 0,
    startTx: 0,
    startTy: 0,
  });

  const onTouchStart = (e: React.TouchEvent) => {
    const g = touch.current;
    if (e.touches.length === 2) {
      const [a, b] = [e.touches[0], e.touches[1]];
      g.mode = "pinch";
      g.startDist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      g.startScale = scale;
    } else if (e.touches.length === 1) {
      const t = e.touches[0];
      // Zoomed in → one finger pans; fitted → one finger is a navigation swipe.
      g.mode = scale > MIN_SCALE ? "pan" : "swipe";
      g.startX = t.clientX;
      g.startY = t.clientY;
      g.startTx = tx;
      g.startTy = ty;
    }
  };

  const onTouchMove = (e: React.TouchEvent) => {
    const g = touch.current;
    if (g.mode === "pinch" && e.touches.length === 2) {
      const [a, b] = [e.touches[0], e.touches[1]];
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      setScale(clamp(g.startScale * (d / (g.startDist || 1)), MIN_SCALE, MAX_SCALE));
    } else if (g.mode === "pan" && e.touches.length === 1) {
      const t = e.touches[0];
      setTx(g.startTx + (t.clientX - g.startX));
      setTy(g.startTy + (t.clientY - g.startY));
    }
  };

  const onTouchEnd = (e: React.TouchEvent) => {
    const g = touch.current;
    if (g.mode === "swipe") {
      const t = e.changedTouches[0];
      const dx = t.clientX - g.startX;
      const dy = t.clientY - g.startY;
      if (Math.abs(dx) > SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
        if (dx < 0) onIndexChange(Math.min(index + 1, last));
        else onIndexChange(Math.max(index - 1, 0));
      }
    }
    if (e.touches.length === 0) g.mode = "none";
  };

  // Double-click/tap toggles between fit and a 2× zoom.
  const onDoubleClick = () => setScale((s) => (s > MIN_SCALE ? MIN_SCALE : 2));

  const item = items[index];
  if (!item) return null;

  // Items that don't carry a derivative_status (e.g. always-ready exports) are
  // assumed displayable; otherwise we only show it once the derivative is ready.
  const ready = item.derivative_status ? item.derivative_status === "ready" : true;

  // RAW+JPEG pairing: a paired photo can be viewed as its primary (JPEG/HEIF) or
  // its RAW companion. When showing the companion, source its proxy directly
  // (custom mediaSrc overrides don't apply to the companion asset).
  const hasCompanion = item.companion_id != null && !!item.companion_ext;
  const companionShown = hasCompanion && showCompanion;
  const currentSrc = companionShown
    ? `/api/assets/${item.companion_id}/proxy`
    : mediaSrc(item);

  const transform = {
    transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
    cursor: scale > MIN_SCALE ? "grab" : undefined,
  };

  // Render through a portal on <body>: the overlay is position:fixed, so any
  // ancestor with a transform (e.g. a card's hover lift) would otherwise become
  // its containing block and shrink/flicker it. The portal keeps it viewport-
  // anchored everywhere it's reused.
  const overlay = (
    <div className="viewer">
      <button className="close" onClick={onClose} aria-label="Close viewer">
        ×
      </button>
      {!panelOpen && (
        <button
          className="viewer-info-btn"
          onClick={() => setPanelOpen(true)}
          aria-label="Show info"
          title="Show info"
        >
          ⓘ
        </button>
      )}
      <div className="viewer-body">
        <div
          ref={stageRef}
          className="stage"
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onDoubleClick={onDoubleClick}
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
                style={transform}
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={companionShown ? `c${item.companion_id}` : item.id}
                src={currentSrc}
                alt={item.filename}
                style={transform}
              />
            )
          ) : (
            <div className="placeholder">Derivative unavailable</div>
          )}
        </div>
        {panelOpen && (
          <aside className="viewer-panel">
            <div className="viewer-panel-head">
              <strong className="viewer-panel-name">{item.filename}</strong>
              <button
                className="viewer-panel-toggle"
                onClick={() => setPanelOpen(false)}
                aria-label="Hide info"
                title="Hide info"
              >
                ×
              </button>
            </div>
            <AssetMeta asset={item} />
            {renderInfo?.(item)}
          </aside>
        )}
      </div>
      <div className="controls">
        {hasCompanion && (
          <div
            className="vbar-verdict vbar-format"
            role="group"
            aria-label="Format"
          >
            <button
              type="button"
              className={`vbar-btn${!companionShown ? " active" : ""}`}
              aria-pressed={!companionShown}
              onClick={() => setShowCompanion(false)}
            >
              {fmtExt(item.ext)}
            </button>
            <button
              type="button"
              className={`vbar-btn${companionShown ? " active" : ""}`}
              aria-pressed={companionShown}
              title="Show the RAW source"
              onClick={() => setShowCompanion(true)}
            >
              {fmtExt(item.companion_ext)}
            </button>
          </div>
        )}
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

  if (typeof document === "undefined") return overlay;
  return createPortal(overlay, document.body);
}
