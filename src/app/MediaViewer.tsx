"use client";

// Reusable full-screen media viewer (the dark lightbox). Extracted from the
// gallery so any surface — the cull grid, the Exports library, anywhere — can
// show a photo/video at full size with the same chrome, keyboard navigation and
// metadata panel.
//
// It owns only what is universal: rendering the current media, prev/next
// navigation (buttons + arrow keys + touch swipe), zoom (pinch/trackpad,
// mouse wheel, double-click) with pan (touch drag or mouse drag),
// Escape-to-close and the (toggleable) metadata bottom panel. Everything
// contextual (rating controls, tag editing, a download button…) is injected by
// the caller through `renderActions` / `renderInfo`, and extra shortcuts through
// `onKeyDown`. Media URLs default to the asset derivatives but can be overridden
// (e.g. an export item keyed by its source asset).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import AssetMeta, { type AssetMetaInput } from "./gallery/AssetMeta";
import { formatBytes, formatDimensions } from "@/lib/format";

export type ViewerItem = AssetMetaInput & {
  id: number;
  filename: string;
  media_type?: "photo" | "video";
  derivative_status?: string;
  // Pairing (cf. lib/pairing.ts). When the item has a companion, the viewer
  // offers a segmented toggle to swap the displayed source between this primary
  // and its companion: the RAW source of a RAW+JPEG pair (shown as an image), or
  // the .mov motion of an iPhone Live Photo (played as a video). `ext`/
  // `companion_ext` label the two segments; `group_kind`/`companion_media_type`
  // pick how the companion is rendered; the companion's own filename/size/
  // dimensions let the panel describe that side while it's the one on screen.
  ext?: string;
  companion_id?: number | null;
  companion_ext?: string | null;
  companion_media_type?: "photo" | "video" | null;
  companion_filename?: string | null;
  companion_file_size?: number | null;
  companion_width?: number | null;
  companion_height?: number | null;
  group_kind?: "raw_jpeg" | "live_photo" | null;
  // Finals → sources counterpart (cf. lib/reconcile.ts). When present, the viewer
  // offers a Before/After toggle that swaps the displayed media between this
  // asset and its counterpart — the source original of an edited final, or the
  // first edit of a source — sourcing the counterpart's proxy directly (no list
  // navigation needed, just like the RAW/JPEG companion toggle).
  original_asset_id?: number | null;
  original_filename?: string | null;
  original_ext?: string | null;
  edit_count?: number;
  first_edit_id?: number | null;
  first_edit_filename?: string | null;
  first_edit_ext?: string | null;
};

// "jpg"/"DNG" segment label from an extension (".jpg" → "JPG").
const fmtExt = (ext?: string | null) =>
  (ext ?? "").replace(".", "").toUpperCase();

// One member of a RAW+JPEG group, summarised for the at-a-glance pair block:
// its format badge plus the per-file stats (dimensions, size) that differ
// between the two sides. `null` stats are simply omitted.
const memberStats = (
  ext?: string | null,
  width?: number | null,
  height?: number | null,
  size?: number | null,
) =>
  [formatDimensions(width, height), size != null ? formatBytes(size) : null]
    .filter(Boolean)
    .join(" · ");

// Swap the extension on a path/filename so the companion's location can be shown
// from the primary's — a pair shares its basename and directory by construction
// (cf. lib/pairing.ts), only the extension differs.
const swapExt = (path: string, ext: string) =>
  path.replace(/\.[^./]+$/, ext);

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

  // Finals → sources: whether the counterpart (before/after) is displayed instead
  // of this asset. Mutually exclusive with the companion toggle below.
  const [showCounterpart, setShowCounterpart] = useState(false);

  // Zoom/pan transform applied to the current media. Reset whenever we move to
  // another item so each photo/video starts fitted.
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const [dragging, setDragging] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setScale(1);
    setTx(0);
    setTy(0);
    setShowCompanion(false);
    setShowCounterpart(false);
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

  // Wheel zoom. Trackpad pinch reaches the browser as ctrl+wheel with fine
  // deltas; a plain mouse wheel sends coarse notches. Both zoom the stage (it
  // has nothing to scroll), so we take over the event either way. Attached
  // natively so we can call preventDefault — React's onWheel is passive and
  // would let the page zoom/scroll instead.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setScale((s) =>
        e.ctrlKey
          ? // Trackpad pinch: proportional to the pinch delta.
            clamp(s - e.deltaY * 0.01, MIN_SCALE, MAX_SCALE)
          : // Mouse wheel: a fixed multiplicative step per notch, independent of
            // the OS-reported delta magnitude (pixels vs lines).
            clamp(s * (e.deltaY < 0 ? 1.15 : 1 / 1.15), MIN_SCALE, MAX_SCALE),
      );
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

  // Mouse drag to pan when zoomed in (desktop). This is the pointer equivalent
  // of the one-finger touch pan above. The move/up listeners go on window for
  // the duration of the drag so panning keeps tracking when the cursor leaves
  // the stage and always releases, even on a mouseup outside it.
  const drag = useRef({ startX: 0, startY: 0, startTx: 0, startTy: 0 });

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || scale <= MIN_SCALE) return; // left-button pan, zoomed only
    e.preventDefault(); // suppress the browser's native image drag
    const d = drag.current;
    d.startX = e.clientX;
    d.startY = e.clientY;
    d.startTx = tx;
    d.startTy = ty;
    setDragging(true);
    const onMove = (ev: MouseEvent) => {
      setTx(d.startTx + (ev.clientX - d.startX));
      setTy(d.startTy + (ev.clientY - d.startY));
    };
    const onUp = () => {
      setDragging(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // A <video> renders its own native controls (the scrubber especially): a
  // one-finger drag on the timeline is scrubbing, not a navigation swipe. Keep
  // those single-finger touches from bubbling up to the stage so releasing the
  // scrubber doesn't fire a swipe. Two-finger gestures still reach the stage so
  // pinch-zoom keeps working over the video.
  const stopVideoTouch = (e: React.TouchEvent) => {
    if (e.touches.length < 2) e.stopPropagation();
  };

  // Likewise for the mouse: keep a press on the video (its native controls)
  // from starting a stage pan, so play/scrub stay usable even when zoomed in.
  const stopVideoMouse = (e: React.MouseEvent) => e.stopPropagation();

  const item = items[index];
  if (!item) return null;

  // Items that don't carry a derivative_status (e.g. always-ready exports) are
  // assumed displayable; otherwise we only show it once the derivative is ready.
  const ready = item.derivative_status ? item.derivative_status === "ready" : true;

  // Pairing: a paired asset can be viewed as its primary or its companion. When
  // showing the companion, source its proxy directly (custom mediaSrc overrides
  // don't apply to the companion asset). A Live Photo's companion is its .mov
  // motion → rendered as a <video>; a RAW companion is rendered as an image.
  const hasCompanion = item.companion_id != null && !!item.companion_ext;
  const companionShown = hasCompanion && showCompanion;
  const companionIsVideo =
    item.companion_media_type === "video" ||
    item.group_kind === "live_photo";

  // Finals → sources counterpart. An edited final points at its source original
  // (`original_asset_id`); a source points at its first edit (`first_edit_id`).
  // Either way the toggle swaps the on-screen media to the counterpart's proxy.
  const isEdit = item.original_asset_id != null;
  const counterpartId = isEdit
    ? (item.original_asset_id ?? null)
    : (item.first_edit_id ?? null);
  const hasCounterpart = counterpartId != null;
  const counterpartShown = hasCounterpart && showCounterpart;
  const counterpartLabel = isEdit ? "Original" : "Edit";
  const selfLabel = isEdit ? "Edit" : "Original";
  const counterpartFilename = isEdit
    ? item.original_filename
    : item.first_edit_filename;
  const counterpartExt = isEdit ? item.original_ext : item.first_edit_ext;

  const currentSrc = counterpartShown
    ? `/api/assets/${counterpartId}/proxy`
    : companionShown
      ? `/api/assets/${item.companion_id}/proxy`
      : mediaSrc(item);

  // The file actually on screen. EXIF (date/camera/exposure/GPS) is shared
  // across a pair, so only the file-level fields — name, type, size, dimensions
  // and path — switch to the companion's when the RAW side is displayed. This
  // keeps the header and metadata panel describing what you're looking at rather
  // than always the primary.
  const displayed: AssetMetaInput & { filename: string } = counterpartShown
    ? {
        // The counterpart is a different file in another folder. EXIF (capture
        // date, camera, exposure) is shared with this asset — that's *why* they
        // pair — so keep it; only the file identity (name/ext) is the
        // counterpart's. We don't carry its size/dimensions, so omit them rather
        // than show this asset's.
        ...item,
        filename: counterpartFilename ?? item.filename,
        ext: counterpartExt ?? item.ext,
        file_size: null,
        width: null,
        height: null,
        rel_path: null,
      }
    : companionShown
      ? {
          ...item,
          filename: item.companion_filename ?? item.filename,
          ext: item.companion_ext ?? item.ext,
          file_size: item.companion_file_size ?? item.file_size,
          width: item.companion_width ?? item.width,
          height: item.companion_height ?? item.height,
          rel_path: item.rel_path
            ? swapExt(item.rel_path, item.companion_ext ?? "")
            : null,
        }
      : item;

  const transform = {
    transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
    cursor: scale > MIN_SCALE ? (dragging ? "grabbing" : "grab") : undefined,
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
          onMouseDown={onMouseDown}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onDoubleClick={onDoubleClick}
          onContextMenu={onContextMenu ? (e) => onContextMenu(e, item) : undefined}
        >
          {ready ? (
            companionShown && companionIsVideo ? (
              // Live Photo motion: play the companion .mov proxy in place.
              <video
                key={`c${item.companion_id}`}
                src={currentSrc}
                poster={posterSrc(item)}
                controls
                playsInline
                autoPlay
                muted
                loop
                style={transform}
                onMouseDown={stopVideoMouse}
                onTouchStart={stopVideoTouch}
                onTouchMove={stopVideoTouch}
                onTouchEnd={stopVideoTouch}
              />
            ) : item.media_type === "video" ? (
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
                onMouseDown={stopVideoMouse}
                onTouchStart={stopVideoTouch}
                onTouchMove={stopVideoTouch}
                onTouchEnd={stopVideoTouch}
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={
                  counterpartShown
                    ? `e${counterpartId}`
                    : companionShown
                      ? `c${item.companion_id}`
                      : item.id
                }
                src={currentSrc}
                alt={displayed.filename}
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
              <strong className="viewer-panel-name" title={displayed.filename}>
                {displayed.filename}
              </strong>
              <button
                className="viewer-panel-toggle"
                onClick={() => setPanelOpen(false)}
                aria-label="Hide info"
                title="Hide info"
              >
                ×
              </button>
            </div>
            <AssetMeta asset={displayed} />
            {hasCompanion && (
              // Group info: a pair is one logical media made of two files —
              // RAW+JPEG, or an iPhone Live Photo (still + .mov motion). Surface
              // both members so the relationship is explicit, and let either be
              // selected straight from here (mirrors the format toggle in the
              // controls bar). The active side is the one on screen.
              <div className="viewer-pair">
                <div className="viewer-pair-label">
                  {item.group_kind === "live_photo"
                    ? "Live Photo"
                    : "RAW + JPEG pair"}
                </div>
                <button
                  type="button"
                  className={`viewer-pair-member${!companionShown ? " active" : ""}`}
                  aria-pressed={!companionShown}
                  onClick={() => setShowCompanion(false)}
                >
                  <span className="viewer-pair-ext">{fmtExt(item.ext)}</span>
                  <span className="viewer-pair-stat">
                    {memberStats(
                      item.ext,
                      item.width,
                      item.height,
                      item.file_size,
                    )}
                  </span>
                </button>
                <button
                  type="button"
                  className={`viewer-pair-member${companionShown ? " active" : ""}`}
                  aria-pressed={companionShown}
                  title={
                    item.group_kind === "live_photo"
                      ? "Play the Live Photo motion"
                      : "Show the RAW source"
                  }
                  onClick={() => {
                    setShowCounterpart(false);
                    setShowCompanion(true);
                  }}
                >
                  <span className="viewer-pair-ext">
                    {item.group_kind === "live_photo"
                      ? "LIVE"
                      : fmtExt(item.companion_ext)}
                  </span>
                  <span className="viewer-pair-stat">
                    {memberStats(
                      item.companion_ext,
                      item.companion_width,
                      item.companion_height,
                      item.companion_file_size,
                    )}
                  </span>
                </button>
              </div>
            )}
            {hasCounterpart && (
              // Finals → sources: this asset paired with its before/after
              // counterpart — the source original of an edited final, or the edit
              // produced from a source. Selecting a side swaps the on-screen
              // media, exactly like the RAW/JPEG format toggle above.
              <div className="viewer-pair">
                <div className="viewer-pair-label">
                  {isEdit
                    ? "Edited from source"
                    : `Edit${(item.edit_count ?? 0) > 1 ? `s · ${item.edit_count}` : ""}`}
                </div>
                <button
                  type="button"
                  className={`viewer-pair-member${!counterpartShown ? " active" : ""}`}
                  aria-pressed={!counterpartShown}
                  onClick={() => setShowCounterpart(false)}
                >
                  <span className="viewer-pair-ext">{selfLabel}</span>
                  <span className="viewer-pair-stat" title={item.filename}>
                    {item.filename}
                  </span>
                </button>
                <button
                  type="button"
                  className={`viewer-pair-member${counterpartShown ? " active" : ""}`}
                  aria-pressed={counterpartShown}
                  title={
                    isEdit
                      ? "Show the source original"
                      : "Show the edited version"
                  }
                  onClick={() => {
                    setShowCompanion(false);
                    setShowCounterpart(true);
                  }}
                >
                  <span className="viewer-pair-ext">{counterpartLabel}</span>
                  <span
                    className="viewer-pair-stat"
                    title={counterpartFilename ?? ""}
                  >
                    {counterpartFilename ?? "—"}
                  </span>
                </button>
              </div>
            )}
            {renderInfo?.(item)}
          </aside>
        )}
      </div>
      <div className="controls">
        {/* The pair switcher lives in the info panel (viewer-pair) whenever it's
            open; only surface the format toggle down here when the panel is
            hidden, so the two never duplicate and the action bar stays on one
            line in the default (panel-open) layout. */}
        {hasCompanion && !panelOpen && (
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
              title={
                item.group_kind === "live_photo"
                  ? "Play the Live Photo motion"
                  : "Show the RAW source"
              }
              onClick={() => setShowCompanion(true)}
            >
              {item.group_kind === "live_photo"
                ? "LIVE"
                : fmtExt(item.companion_ext)}
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
