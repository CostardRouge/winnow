"use client";

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { LazyImage, Icons } from "./ui";

// A single derivative tile, plus the responsive horizontal strip that lays a
// row of them out edge-to-edge: a ResizeObserver fits as many fixed-size tiles
// as the container's width allows and caps the rest behind a trailing "+N"
// tile. Shared by the exports cards and the incoming sessions list so both
// preview their contents identically.
//
// The per-tile extras (an extension badge and a hover download icon) light up
// only when the caller supplies that data, so the same component serves the
// rich exports view and the bare sessions preview from one code path.

export type StripItem = {
  key: string | number;
  /** Thumbnail URL. Omit (or set `pending`) to show a placeholder instead. */
  thumbSrc?: string;
  /** File extension shown as a corner badge (e.g. "arw"). */
  ext?: string | null;
  /** Video tile: a play badge over a ready thumbnail / a 🎬 placeholder. */
  isVideo?: boolean;
  /** Derivative not ready yet → placeholder instead of the image. */
  pending?: boolean;
  /** Per-file download href. When set, a download icon appears on hover. */
  downloadHref?: string;
  /** Tooltip / image alt (typically the filename). */
  title?: string;
};

const THUMB = 76; // default tile size (px)
const GAP = 6;

/** One derivative tile. Interactive (opens the viewer / navigates) when given
 *  an `onActivate`; otherwise a plain preview. */
export function Thumb({
  item,
  style,
  onActivate,
}: {
  item: StripItem;
  style?: CSSProperties;
  onActivate?: () => void;
}) {
  const ready = Boolean(item.thumbSrc) && !item.pending;
  const interactive = Boolean(onActivate);
  return (
    <div
      className="thumb-tile"
      style={style}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={
        onActivate
          ? (e) => {
              e.stopPropagation();
              onActivate();
            }
          : undefined
      }
      onKeyDown={
        onActivate
          ? (e: KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onActivate();
              }
            }
          : undefined
      }
      title={item.title}
    >
      {ready ? (
        <LazyImage src={item.thumbSrc as string} alt={item.title ?? ""} />
      ) : (
        <span className="thumb-tile-ph">{item.isVideo ? "🎬" : "⏳"}</span>
      )}
      {item.isVideo && ready && <span className="play-badge">▶</span>}
      {item.downloadHref && (
        <a
          className="thumb-dl"
          href={item.downloadHref}
          download
          onClick={(e) => e.stopPropagation()}
          title={`Download ${item.title ?? "file"}`}
          aria-label={`Download ${item.title ?? "file"}`}
        >
          {Icons.download}
        </a>
      )}
      {item.ext ? (
        <span className="ext-badge">{item.ext.replace(".", "")}</span>
      ) : null}
    </div>
  );
}

export default function ThumbStrip({
  items,
  total,
  size = THUMB,
  gap = GAP,
  className,
  onItemActivate,
  onOverflowActivate,
}: {
  /** The tiles to show; `null` renders loading skeletons. */
  items: StripItem[] | null;
  /** Real total to advertise in the "+N" tile (defaults to `items.length`). */
  total?: number;
  size?: number;
  gap?: number;
  className?: string;
  /** Activate a tile (open the viewer / go to the session). */
  onItemActivate?: (index: number) => void;
  /** Activate the "+N" tile or the empty strip area (expand / go to session). */
  onOverflowActivate?: () => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(8);

  // How many tiles fit on one line — recomputed as the row resizes.
  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const measure = (w: number) =>
      setFit(Math.max(1, Math.floor((w + gap) / (size + gap))));
    measure(el.clientWidth);
    const ro = new ResizeObserver((entries) =>
      measure(entries[0].contentRect.width),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, [size, gap, items]);

  if (items != null && items.length === 0) return null;

  const tileStyle: CSSProperties = { width: size, height: size, flexShrink: 0 };
  const available = items?.length ?? 0;
  const count = total ?? available;
  // Show everything only when it both fits and we actually hold every tile;
  // otherwise reserve the last slot for a "+N" that advertises the true total.
  const canShowAll = count <= fit && available >= count;
  const shown = canShowAll
    ? available
    : Math.min(available, Math.max(1, fit - 1));
  const overflowN = canShowAll ? 0 : count - shown;
  const clickable = Boolean(onOverflowActivate);

  return (
    <div
      ref={rowRef}
      className={`thumb-row${clickable ? " is-clickable" : ""}${className ? ` ${className}` : ""}`}
      style={{ gap }}
      onClick={onOverflowActivate}
      title={clickable ? "Show all" : undefined}
    >
      {items == null
        ? Array.from({ length: Math.max(1, fit) }).map((_, i) => (
            <span key={i} className="skeleton" style={tileStyle} />
          ))
        : items
            .slice(0, shown)
            .map((it, idx) => (
              <Thumb
                key={it.key}
                item={it}
                style={tileStyle}
                onActivate={
                  onItemActivate ? () => onItemActivate(idx) : undefined
                }
              />
            ))}
      {overflowN > 0 && (
        <div
          className="thumb-tile thumb-more"
          style={tileStyle}
          role={clickable ? "button" : undefined}
          tabIndex={clickable ? 0 : undefined}
          onClick={
            onOverflowActivate
              ? (e) => {
                  e.stopPropagation();
                  onOverflowActivate();
                }
              : undefined
          }
          onKeyDown={
            onOverflowActivate
              ? (e: KeyboardEvent) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onOverflowActivate();
                  }
                }
              : undefined
          }
        >
          +{overflowN}
        </div>
      )}
    </div>
  );
}
