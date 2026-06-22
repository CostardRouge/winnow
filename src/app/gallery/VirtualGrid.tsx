"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { FixedSizeList, type ListOnItemsRenderedProps } from "react-window";

export type GalleryAsset = {
  id: number;
  filename: string;
  ext: string;
  media_type: "photo" | "video";
  derivative_status: string;
  file_size: number | null;
  verdict: "pick" | "reject" | "unrated";
  star: number;
  // Pairing (cf. lib/pairing.ts): the companion of this displayed primary, if
  // any, plus the group kind. Drives the corner badge — "RAW+…" for a RAW+JPEG
  // pair, "LIVE" for an iPhone Live Photo.
  companion_id?: number | null;
  companion_ext?: string | null;
  companion_media_type?: "photo" | "video" | null;
  group_kind?: "raw_jpeg" | "live_photo" | null;
};

const TARGET = 175; // target cell width (px)
const GAP = 6;

export default function VirtualGrid({
  items,
  hasMore,
  loading,
  loadMore,
  onOpen,
  selectMode = false,
  selectedIds,
  onToggleSelect,
  onContextMenu,
  targetWidth = TARGET,
}: {
  items: GalleryAsset[];
  hasMore: boolean;
  loading: boolean;
  loadMore: () => void;
  onOpen: (index: number) => void;
  selectMode?: boolean;
  selectedIds?: Set<number>;
  onToggleSelect?: (id: number) => void;
  onContextMenu?: (e: React.MouseEvent, asset: GalleryAsset) => void;
  /** Target cell width (px). Smaller → more media per line. */
  targetWidth?: number;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setSize({ w: Math.floor(r.width), h: Math.floor(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const cols = Math.max(2, Math.floor((size.w + GAP) / (targetWidth + GAP))) || 2;
  const cell = size.w > 0 ? Math.floor((size.w - GAP * (cols - 1)) / cols) : targetWidth;
  const rowHeight = cell + GAP;
  const rowCount = Math.ceil(items.length / cols);

  const onItemsRendered = useCallback(
    (p: ListOnItemsRenderedProps) => {
      if (!loading && hasMore && p.visibleStopIndex >= rowCount - 3) loadMore();
    },
    [loading, hasMore, rowCount, loadMore],
  );

  const Row = ({ index, style }: { index: number; style: React.CSSProperties }) => {
    const start = index * cols;
    const cells = items.slice(start, start + cols);
    return (
      <div style={{ ...style, display: "flex", gap: GAP }}>
        {cells.map((a, j) => {
          const idx = start + j;
          const sel = selectMode && selectedIds?.has(a.id);
          return (
            <div
              key={a.id}
              className={`cell ${a.verdict}${sel ? " selected" : ""}`}
              style={{ width: cell, height: cell, aspectRatio: "auto" }}
              onClick={() =>
                selectMode ? onToggleSelect?.(a.id) : onOpen(idx)
              }
              onContextMenu={onContextMenu ? (e) => onContextMenu(e, a) : undefined}
            >
              {a.derivative_status === "ready" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`/api/assets/${a.id}/thumb`} alt={a.filename} loading="lazy" />
              ) : (
                <div className="placeholder">
                  {a.derivative_status === "error"
                    ? "⚠ error"
                    : a.media_type === "video"
                      ? "🎬 video"
                      : "⏳"}
                </div>
              )}
              {a.media_type === "video" && a.derivative_status === "ready" && (
                <span className="play-badge">▶</span>
              )}
              {a.verdict !== "unrated" && (
                <span className="badge">{a.verdict === "pick" ? "✓" : "✕"}</span>
              )}
              {a.star > 0 && <span className="stars">{"★".repeat(a.star)}</span>}
              <span className={`ext-badge${a.companion_ext ? " paired" : ""}`}>
                {a.group_kind === "live_photo"
                  ? "LIVE"
                  : a.companion_ext
                    ? `RAW+${a.ext.replace(".", "")}`
                    : a.ext.replace(".", "")}
              </span>
              {sel && <span className="select-check">✓</span>}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div ref={wrapRef} style={{ flex: 1, minHeight: 0 }}>
      {size.h > 0 && size.w > 0 && (
        <FixedSizeList
          height={size.h}
          width={size.w}
          itemCount={rowCount}
          itemSize={rowHeight}
          onItemsRendered={onItemsRendered}
          overscanCount={4}
        >
          {Row}
        </FixedSizeList>
      )}
    </div>
  );
}
