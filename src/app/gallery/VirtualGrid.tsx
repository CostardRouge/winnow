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
};

const TARGET = 175; // largeur cible d'une cellule (px)
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
}: {
  items: GalleryAsset[];
  hasMore: boolean;
  loading: boolean;
  loadMore: () => void;
  onOpen: (index: number) => void;
  selectMode?: boolean;
  selectedIds?: Set<number>;
  onToggleSelect?: (id: number) => void;
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

  const cols = Math.max(2, Math.floor((size.w + GAP) / (TARGET + GAP))) || 2;
  const cell = size.w > 0 ? Math.floor((size.w - GAP * (cols - 1)) / cols) : TARGET;
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
              {a.verdict !== "unrated" && (
                <span className="badge">{a.verdict === "pick" ? "✓" : "✕"}</span>
              )}
              {a.star > 0 && <span className="stars">{"★".repeat(a.star)}</span>}
              <span className="ext-badge">{a.ext.replace(".", "")}</span>
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
