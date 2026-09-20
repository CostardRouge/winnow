"use client";

import {
  forwardRef,
  memo,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useCallback,
} from "react";
import { List, type ListImperativeAPI, type RowComponentProps } from "react-window";
import { formatBadge } from "@/lib/format";
import { isLivePhoto, LiveMotionVideo } from "../LivePhotoPreview";

export type GalleryAsset = {
  id: number;
  filename: string;
  ext: string;
  media_type: "photo" | "video";
  derivative_status: string;
  file_size: number | null;
  verdict: "pick" | "reject" | "skip" | "unrated";
  star: number;
  // Pairing (cf. lib/pairing.ts): the companion of this displayed primary, if
  // any, plus the group kind. Drives the corner badge — "RAW+…" for a RAW+JPEG
  // pair, "LIVE" for an iPhone Live Photo.
  companion_id?: number | null;
  companion_ext?: string | null;
  companion_media_type?: "photo" | "video" | null;
  group_kind?: "raw_jpeg" | "live_photo" | null;
  // A DJI drone flight-log .SRT rides with this clip → show a telemetry badge.
  has_telemetry?: boolean;
  // Burst/bracket pile size (cf. lib/bursts.ts). In the collapsed grid the pile
  // shows as its cover tile only — the badge says how many frames it stands for.
  // Expanding piles lives in the session grid (the culling surface); here the
  // badge just keeps the collapsed frames from reading as missing photos.
  burst_count?: number | null;
  // The pile itself, if any — lets the media viewer fetch this cover's sibling
  // frames for its filmstrip (cf. MediaViewer.tsx).
  burst_id?: number | null;
  // 'bracket' (exposure-bracketed / AEB) vs 'action' (continuous shooting) —
  // cf. Burst.kind, lib/bursts.ts. Distinguishes the pile badge's style/label.
  burst_kind?: "action" | "bracket" | null;
};

const TARGET = 175; // target cell width (px)
const GAP = 6;

// Overscan is budgeted in TILES, not in rows. react-window counts rows, but the
// cost of a mounted row is its column count: at the Small density a desktop
// viewport is ~16 columns wide, so a flat "4 rows" meant 64 speculative tiles
// (with their images) either side of the viewport, against 24 at Large. Divide
// a fixed tile budget by the live column count instead and the DOM the grid
// carries stays roughly the same whatever the density — which is the number
// that decides how much work a scroll frame does. The floor keeps one prepared
// row in each direction so a slow scroll never lands on an empty band.
const OVERSCAN_TILES = 32;
const OVERSCAN_MIN = 1;
const OVERSCAN_MAX = 4;

// Long-press (touch) opens the same context menu right-click does. 450ms is
// under the ~500ms at which Android fires its native contextmenu event, so on
// Android both paths land on the same open menu instead of racing; the slop
// keeps a scroll that starts on a tile from reading as a press.
const LONG_PRESS_MS = 450;
const LONG_PRESS_SLOP = 10;

// What the context-menu callback actually receives: a real right-click
// MouseEvent satisfies this, and a mobile long-press synthesizes one from the
// touch position. Hosts only ever read the coordinates and call
// preventDefault, so this is the whole contract.
export type TileMenuEvent = {
  clientX: number;
  clientY: number;
  preventDefault: () => void;
};

// Everything a row needs to paint its slice of the grid. react-window v2 hands
// these to the row component through the `rowProps` prop (and re-renders rows
// when they change), which is why Row lives at module scope: an inline
// component would be a fresh identity on every parent render and remount every
// tile.
type RowData = {
  items: GalleryAsset[];
  cols: number;
  cell: number;
  selectMode: boolean;
  selectedIds?: Set<number>;
  onOpen: (index: number) => void;
  onToggleSelect?: (id: number) => void;
  onContextMenu?: (e: TileMenuEvent, asset: GalleryAsset) => void;
  // Long-press plumbing (present only when onContextMenu is): the grid owns
  // the single shared timer, rows just report the touches.
  onPressStart?: (e: React.TouchEvent, asset: GalleryAsset) => void;
  onPressMove?: (e: React.TouchEvent) => void;
  onPressEnd?: (e: React.TouchEvent) => void;
  consumePress?: () => boolean;
};

type TileProps = {
  asset: GalleryAsset;
  index: number;
  cell: number;
  selected: boolean;
  selectMode: boolean;
  onOpen: (index: number) => void;
  onToggleSelect?: (id: number) => void;
  onContextMenu?: (e: TileMenuEvent, asset: GalleryAsset) => void;
  onPressStart?: (e: React.TouchEvent, asset: GalleryAsset) => void;
  onPressMove?: (e: React.TouchEvent) => void;
  onPressEnd?: (e: React.TouchEvent) => void;
  consumePress?: () => boolean;
};

// One tile, memoized. This is the unit that repeats by the hundred, so it is
// also the unit React must be able to skip: react-window hands a row the whole
// `items` array, and appending a page (or toggling one selection) gives that
// array a new identity — without the memo every mounted tile re-rendered its
// image and its five badges for a change that touched none of them. The asset
// objects themselves are stable across an append, so the default shallow
// compare is exactly the right test.
const Tile = memo(function Tile({
  asset: a,
  index,
  cell,
  selected,
  selectMode,
  onOpen,
  onToggleSelect,
  onContextMenu,
  onPressStart,
  onPressMove,
  onPressEnd,
  consumePress,
}: TileProps) {
  const live = isLivePhoto(a);
  // Live Photo: the motion (.mov companion) plays in place over the still while
  // the tile is hovered. The state is the TILE's, not the grid's — held one
  // level up it was a prop of every row, so moving the mouse across one live
  // tile re-rendered every tile on screen; here it re-renders the one being
  // pointed at, and "one at a time" holds by construction. No-op on touch (no
  // hover) — there the viewer's LIVE toggle plays it.
  const [motion, setMotion] = useState(false);

  return (
    <div
      className={`cell ${a.verdict}${selected ? " selected" : ""}`}
      style={{ width: cell, height: cell, aspectRatio: "auto" }}
      onClick={() => {
        // A long-press that opened the menu also releases into a click
        // (iOS synthesizes one) — that click must not open the viewer.
        if (consumePress?.()) return;
        if (selectMode) onToggleSelect?.(a.id);
        else onOpen(index);
      }}
      onMouseEnter={live ? () => setMotion(true) : undefined}
      onMouseLeave={live ? () => setMotion(false) : undefined}
      onContextMenu={onContextMenu ? (e) => onContextMenu(e, a) : undefined}
      onTouchStart={onPressStart ? (e) => onPressStart(e, a) : undefined}
      onTouchMove={onPressMove}
      onTouchEnd={onPressEnd}
      onTouchCancel={onPressEnd}
    >
      {a.derivative_status === "ready" ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/assets/${a.id}/thumb`}
          alt={a.filename}
          loading="lazy"
          decoding="async"
        />
      ) : (
        <div className="placeholder">
          {a.derivative_status === "error"
            ? "⚠ error"
            : a.media_type === "video"
              ? "🎬 video"
              : "⏳"}
        </div>
      )}
      {live && a.derivative_status === "ready" && motion && (
        <LiveMotionVideo
          companionId={a.companion_id!}
          poster={`/api/assets/${a.id}/thumb`}
          fit="cover"
        />
      )}
      {a.media_type === "video" && a.derivative_status === "ready" && (
        <span className="play-badge">▶</span>
      )}
      {a.has_telemetry && (
        <span className="telemetry-badge" title="Flight telemetry (SRT)">
          🛰
        </span>
      )}
      {!a.has_telemetry && (a.burst_count ?? 0) > 1 && (
        <span
          className={`stack-badge${a.burst_kind === "bracket" ? " bracket" : ""}`}
          title={
            a.burst_kind === "bracket"
              ? `Exposure-bracketed (AEB) pile of ${a.burst_count} frames — open the session grid to expand it`
              : `Burst pile of ${a.burst_count} frames — open the session grid to expand it`
          }
        >
          {a.burst_kind === "bracket" ? "±" : "⧉"} {a.burst_count}
        </span>
      )}
      {a.verdict !== "unrated" && (
        <span className="badge">
          {a.verdict === "pick" ? "✓" : a.verdict === "reject" ? "✕" : "↪"}
        </span>
      )}
      {a.star > 0 && <span className="stars">{"★".repeat(a.star)}</span>}
      <span className={`ext-badge${a.companion_ext ? " paired" : ""}`}>
        {formatBadge(a.ext, a.companion_ext, a.group_kind)}
      </span>
      {selected && <span className="select-check">✓</span>}
    </div>
  );
});

function Row({
  index,
  style,
  items,
  cols,
  cell,
  selectMode,
  selectedIds,
  onOpen,
  onToggleSelect,
  onContextMenu,
  onPressStart,
  onPressMove,
  onPressEnd,
  consumePress,
}: RowComponentProps<RowData>) {
  const start = index * cols;
  const stop = Math.min(start + cols, items.length);
  // Built by index rather than items.slice(): a slice allocates a throwaway
  // array per row on every render, and the rows re-render on every scroll tick.
  const cells = [];
  for (let i = start; i < stop; i++) {
    const a = items[i];
    cells.push(
      <Tile
        key={a.id}
        asset={a}
        index={i}
        cell={cell}
        selected={selectMode && (selectedIds?.has(a.id) ?? false)}
        selectMode={selectMode}
        onOpen={onOpen}
        onToggleSelect={onToggleSelect}
        onContextMenu={onContextMenu}
        onPressStart={onPressStart}
        onPressMove={onPressMove}
        onPressEnd={onPressEnd}
        consumePress={consumePress}
      />,
    );
  }
  return <div style={{ ...style, display: "flex", gap: GAP }}>{cells}</div>;
}

// Imperative handle: lets the host scroll a given item into view — used to land
// the grid back on the media the viewer was showing when it closes.
export type VirtualGridHandle = {
  scrollToIndex: (index: number) => void;
};

const VirtualGrid = forwardRef<
  VirtualGridHandle,
  {
    items: GalleryAsset[];
    hasMore: boolean;
    loading: boolean;
    loadMore: () => void;
    onOpen: (index: number) => void;
    selectMode?: boolean;
    selectedIds?: Set<number>;
    onToggleSelect?: (id: number) => void;
    /** Right-click on desktop, long-press on touch — one callback for both. */
    onContextMenu?: (e: TileMenuEvent, asset: GalleryAsset) => void;
    /** Target cell width (px). Smaller → more media per line. */
    targetWidth?: number;
  }
>(function VirtualGrid(
  {
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
  },
  ref,
) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<ListImperativeAPI>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  // Long-press → context menu. One finger, held LONG_PRESS_MS without drifting
  // past LONG_PRESS_SLOP, fires onContextMenu at the touch point. A single
  // shared record is enough — there is one long-press at a time. After firing,
  // the record stays (fired: true) until the release's synthesized click is
  // consumed or the next touch replaces it; iOS Safari never fires contextmenu
  // on touch, which is why this exists at all.
  const press = useRef<{
    timer: ReturnType<typeof setTimeout>;
    x: number;
    y: number;
    fired: boolean;
  } | null>(null);

  const onPressStart = useCallback(
    (e: React.TouchEvent, asset: GalleryAsset) => {
      if (press.current) clearTimeout(press.current.timer);
      press.current = null;
      if (!onContextMenu || e.touches.length !== 1) return;
      const t = e.touches[0];
      const state = {
        x: t.clientX,
        y: t.clientY,
        fired: false,
        timer: setTimeout(() => {
          state.fired = true;
          onContextMenu(
            { clientX: state.x, clientY: state.y, preventDefault: () => {} },
            asset,
          );
        }, LONG_PRESS_MS),
      };
      press.current = state;
    },
    [onContextMenu],
  );

  const onPressMove = useCallback((e: React.TouchEvent) => {
    const p = press.current;
    if (!p || p.fired) return;
    const t = e.touches[0];
    if (
      !t ||
      Math.abs(t.clientX - p.x) > LONG_PRESS_SLOP ||
      Math.abs(t.clientY - p.y) > LONG_PRESS_SLOP
    ) {
      clearTimeout(p.timer);
      press.current = null;
    }
  }, []);

  const onPressEnd = useCallback((e: React.TouchEvent) => {
    const p = press.current;
    if (!p) return;
    clearTimeout(p.timer);
    if (p.fired) {
      // The menu is open; keep the browser from synthesizing mouse events for
      // this release (they would land outside the menu and dismiss it at once).
      // touchend is not passive under React, so this is allowed.
      e.preventDefault();
    } else {
      press.current = null;
    }
  }, []);

  // Called by the tile's onClick: true (and reset) when the click is the tail
  // of a long-press that already opened the menu.
  const consumePress = useCallback(() => {
    if (press.current?.fired) {
      press.current = null;
      return true;
    }
    return false;
  }, []);

  useEffect(() => {
    return () => {
      if (press.current) clearTimeout(press.current.timer);
    };
  }, []);

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
  const overscanCount = Math.min(
    OVERSCAN_MAX,
    Math.max(OVERSCAN_MIN, Math.round(OVERSCAN_TILES / cols)),
  );

  // Scroll the row holding `index` into view ("smart": no-op if already visible,
  // so closing the viewer without having navigated far leaves the grid put).
  useImperativeHandle(
    ref,
    () => ({
      scrollToIndex: (index: number) =>
        listRef.current?.scrollToRow({
          index: Math.floor(index / cols),
          align: "smart",
        }),
    }),
    [cols],
  );

  const onRowsRendered = useCallback(
    (visible: { startIndex: number; stopIndex: number }) => {
      if (!loading && hasMore && visible.stopIndex >= rowCount - 3) loadMore();
    },
    [loading, hasMore, rowCount, loadMore],
  );

  // react-window keeps rowProps stable by shallow-comparing its VALUES, and
  // re-renders every mounted row the moment one of them differs. Memoizing here
  // is belt and braces on that: the row array it feeds `Row` is the one thing
  // that must not churn, and the host's callbacks are what used to make it.
  const rowProps: RowData = useMemo(
    () => ({
      items,
      cols,
      cell,
      selectMode,
      selectedIds,
      onOpen,
      onToggleSelect,
      onContextMenu,
      onPressStart: onContextMenu ? onPressStart : undefined,
      onPressMove: onContextMenu ? onPressMove : undefined,
      onPressEnd: onContextMenu ? onPressEnd : undefined,
      consumePress: onContextMenu ? consumePress : undefined,
    }),
    [
      items,
      cols,
      cell,
      selectMode,
      selectedIds,
      onOpen,
      onToggleSelect,
      onContextMenu,
      onPressStart,
      onPressMove,
      onPressEnd,
      consumePress,
    ],
  );

  return (
    <div ref={wrapRef} style={{ flex: 1, minHeight: 0 }}>
      {size.h > 0 && size.w > 0 && (
        <List
          listRef={listRef}
          style={{ height: size.h, width: size.w }}
          rowCount={rowCount}
          rowHeight={rowHeight}
          rowComponent={Row}
          rowProps={rowProps}
          onRowsRendered={onRowsRendered}
          overscanCount={overscanCount}
        />
      )}
    </div>
  );
});

export default VirtualGrid;
