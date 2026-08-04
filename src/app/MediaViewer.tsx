"use client";

// Reusable full-screen media viewer (the dark lightbox). Extracted from the
// gallery so any surface — the cull grid, the Exports library, anywhere — can
// show a photo/video at full size with the same chrome, keyboard navigation and
// metadata panel.
//
// It owns only what is universal: rendering the current media, prev/next
// navigation (buttons + arrow keys + a follow-the-finger touch swipe that
// slides the neighbour in as you drag), zoom (pinch/trackpad,
// mouse wheel, double-click) with pan (touch drag or mouse drag),
// Escape-to-close and the (toggleable) metadata bottom panel. Everything
// contextual (rating controls, tag editing, a download button…) is injected by
// the caller through `renderActions` / `renderInfo`, and extra shortcuts through
// `onKeyDown`. Media URLs default to the asset derivatives but can be overridden
// (e.g. an export item keyed by its source asset).
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import AssetMeta, { type AssetMetaInput } from "./gallery/AssetMeta";
import { formatBytes, formatDimensions } from "@/lib/format";
import { fetchJson } from "@/lib/fetchJson";

// One face detected in the current asset (GET /api/assets/:id/faces): who it
// is plus the pixel bbox in the ANALYZED derivative, whose dimensions ride
// along so the box projects onto the displayed rendition (cf. migration 0021).
type ViewerFace = {
  id: number;
  person_id: number | null;
  person_name: string | null;
  score: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  img_width: number | null;
  img_height: number | null;
};

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
  // Burst/bracket stack (cf. lib/bursts.ts): the pile this frame belongs to, and
  // its live frame count — mirrors the grid's collapsed-cover badge so a pile
  // reads the same way once opened. `burst_count` is null/absent, or ≤1, for a
  // standalone frame. The pile's other frames aren't otherwise in `items` (the
  // grid always collapses a pile to its cover), so the viewer fetches them
  // itself (see BurstFrame below) to feed the filmstrip.
  burst_id?: number | null;
  burst_count?: number | null;
};

// One frame of the current item's burst pile, as returned by
// `/api/assets?burst_id=`. Same projection as the grid (GRID_SELECT), so this
// already carries everything the stage + metadata panel need to display it —
// no per-frame fetch when the filmstrip is clicked.
type BurstFrame = AssetMetaInput & {
  id: number;
  filename: string;
  media_type?: "photo" | "video";
  derivative_status?: string;
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
// A shorter but quicker drag also commits: a release within FLICK_MS that
// travelled at least FLICK_PX reads as a deliberate flick even though it never
// crossed the distance threshold — matches how phone galleries feel.
const FLICK_MS = 250;
const FLICK_PX = 30;
// The first few px of a one-finger drag decide its axis. Horizontal drives the
// swipe track; vertical is ignored outright, so a wobbly vertical motion never
// jiggles the photo sideways.
const AXIS_LOCK_PX = 8;
// Gutter between the current media and the neighbour peeking in from the side
// while dragging. Mirrored in CSS (.stage-pane.is-prev/.is-next) — keep in step.
const PANE_GAP = 32;
// How long the release animation runs: the track sliding fully over to the
// committed neighbour (after which the real index step lands), or springing
// back to centre on a cancelled drag. Matches .stage-track.is-settling in CSS.
const SETTLE_MS = 260;
// How close to the end of the loaded window navigation may get before we ask the
// host to page in the next batch. Kept a few items ahead of the very last so the
// fetch overlaps the time spent looking at the current media — reaching the end
// then feels seamless instead of hitting a wall at the virtual list's boundary.
const PREFETCH_MARGIN = 8;

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

// Viewers can stack: a similar shot opens a second viewer on top of the first
// (cf. gallery/SimilarStrip). Every mounted viewer registers here, and only the
// TOP-MOST one reacts to the keyboard — both listen on window, so without this
// guard one Escape would close every layer at once and the arrow keys would
// navigate the viewer underneath too.
const viewerStack: symbol[] = [];

// Persisted "is the info panel open?" preference, shared across every surface
// that reuses the viewer so the choice sticks between visits.
const PANEL_PREF_KEY = "winnow.viewer.info";

// Read the stored preference synchronously. The viewer only ever mounts on the
// client — every caller starts with a null index and mounts it on interaction —
// so this runs in the `useState` initializer with `localStorage` available, and
// the very first render already reflects the choice. A hidden panel is thus
// never rendered at all (nothing to flash away), and an open one is present from
// the first paint: no reflow either way. Defaults to open when unset or
// unreadable (SSR / private mode / storage disabled).
const readPanelPref = () => {
  if (typeof window === "undefined") return true;
  try {
    return localStorage.getItem(PANEL_PREF_KEY) !== "closed";
  } catch {
    return true;
  }
};

export default function MediaViewer<T extends ViewerItem>({
  items,
  index,
  onIndexChange,
  onClose,
  hasMore = false,
  loading = false,
  loadMore,
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
  /** Whether the host has more pages to page in beyond `items`. */
  hasMore?: boolean;
  /** Whether a page fetch is in flight (host-owned; gates the prefetch). */
  loading?: boolean;
  /** Ask the host to append the next page — lets navigation cross the loaded
   *  window instead of stopping at the virtual list's boundary. */
  loadMore?: () => void;
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

  // This instance's place in the viewer stack (see viewerStack above): pushed
  // on mount, removed on unmount, checked before handling any key.
  const stackId = useRef(Symbol("viewer"));
  useEffect(() => {
    const id = stackId.current;
    viewerStack.push(id);
    return () => {
      const i = viewerStack.indexOf(id);
      if (i >= 0) viewerStack.splice(i, 1);
    };
  }, []);

  // Metadata bottom panel: toggleable down to a small info icon so it never has
  // to cover the media. The open/closed choice is restored from (and mirrored
  // back to) localStorage, so reopening the viewer honours how you last left it.
  const [panelOpen, setPanelOpen] = useState(readPanelPref);

  // Toggle helper that persists the choice alongside the state update. Wrapped
  // in try/catch so a storage failure (private mode) still toggles the panel.
  const setPanel = useCallback((open: boolean) => {
    setPanelOpen(open);
    try {
      localStorage.setItem(PANEL_PREF_KEY, open ? "open" : "closed");
    } catch {
      // Storage unavailable: keep the non-persisted toggle working.
    }
  }, []);

  // RAW+JPEG pairing: which side of the pair is displayed. Resets to the primary
  // (JPEG/HEIF) whenever we move to another item.
  const [showCompanion, setShowCompanion] = useState(false);

  // Finals → sources: whether the counterpart (before/after) is displayed instead
  // of this asset. Mutually exclusive with the companion toggle below.
  const [showCounterpart, setShowCounterpart] = useState(false);

  // Burst/bracket pile (cf. lib/bursts.ts): the current item's sibling frames,
  // fetched on demand and cached per pile (a pile is small and immutable enough
  // during one viewing session that a refetch on every visit would be wasted
  // work). `burstFrameId` is which sibling the filmstrip has picked to preview,
  // if any — null means "show the item itself". Picking a frame only swaps the
  // displayed media/metadata; it deliberately never moves `index`, so prev/next
  // keeps stepping pile-to-pile exactly as it does today (mirrors the grid,
  // where a pile is always one collapsed tile) instead of surprising the user
  // with a jump of N frames the next time they hit →.
  const [burstMembers, setBurstMembers] = useState<BurstFrame[] | null>(null);
  const [burstFrameId, setBurstFrameId] = useState<number | null>(null);
  const burstCache = useRef<Map<number, BurstFrame[]>>(new Map());

  // Whether ← → (buttons, arrow keys, swipe) step through a pile's own frames
  // before moving on to the next item. Off by default: plain component state,
  // never persisted — a session-only compromise so arrow navigation stays
  // predictable (one photo per press) unless deliberately opted into for this
  // viewing session, and stays on across piles once flipped so it doesn't need
  // re-arming for every burst encountered before the viewer is closed.
  const [burstArrowNav, setBurstArrowNav] = useState(false);

  // Zoom/pan transform applied to the current media. Deliberately *kept* across
  // navigation: stepping to the next/previous item preserves the current zoom
  // level and pan offset, so flicking back and forth compares the same framing
  // of successive photos. Only the pair toggles reset per item (below).
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const [dragging, setDragging] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);

  // Follow-the-finger swipe (phone-gallery style). While a one-finger drag is
  // live at fit zoom, the stage's media rides a track translated by `x`, so the
  // current photo slides out as its neighbour slides in from the side. On
  // release the track *settles*: "commit" animates the rest of the way to the
  // neighbour (the real index step lands once the slide finishes), "cancel"
  // springs back to centre. `settle` also toggles the CSS transition — during
  // the drag itself the track follows the finger 1:1 with none.
  const [swipe, setSwipe] = useState<{
    x: number;
    settle: "commit" | "cancel" | null;
  }>({ x: 0, settle: null });
  // True while a commit slide is mid-flight: blocks new drags and any other
  // navigation until the pending step lands (the settle timer clears it) —
  // otherwise an arrow key pressed during the ~quarter-second animation would
  // double-step. The timer is kept so unmounting mid-slide can drop the
  // deferred step (it would otherwise call onIndexChange on a closed viewer).
  const settlingRef = useRef(false);
  const settleTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (settleTimer.current != null) window.clearTimeout(settleTimer.current);
    },
    [],
  );

  // Toggle-to-fit memory for the zoom readout. Clicking the readout snapshots
  // the current zoomed-in transform and drops to fit; clicking again restores
  // that snapshot (level *and* pan), so you can peek at the whole frame and pop
  // straight back to where you were.
  const zoomMemory = useRef({ scale: 2, tx: 0, ty: 0 });

  useEffect(() => {
    setShowCompanion(false);
    setShowCounterpart(false);
    setBurstFrameId(null);
  }, [index]);

  // Load the current item's pile once it's known to have one (burst_count > 1
  // — a lone frame carries a burst_id too briefly if at all, cf. lib/bursts.ts,
  // but is never worth a fetch). Cached by burst_id so flicking prev/next
  // across an already-seen pile (e.g. back onto its cover) doesn't refetch.
  useEffect(() => {
    const it = items[index];
    const burstId = it?.burst_id;
    if (burstId == null || (it?.burst_count ?? 0) <= 1) {
      setBurstMembers(null);
      return;
    }
    const cached = burstCache.current.get(burstId);
    if (cached) {
      setBurstMembers(cached);
      return;
    }
    let cancelled = false;
    fetchJson<{ assets?: BurstFrame[] }>(
      `/api/assets?burst_id=${burstId}&collapse=1&sort_dir=asc&limit=200`,
    )
      .then((data) => {
        if (cancelled) return;
        const members = data.assets ?? [];
        burstCache.current.set(burstId, members);
        setBurstMembers(members);
      })
      .catch(() => {
        if (!cancelled) setBurstMembers(null);
      });
    return () => {
      cancelled = true;
    };
  }, [items, index]);

  // Prefetch the next page as navigation nears the end of the loaded window.
  // The grid's own paging is scroll-driven, so it stalls while the viewer is
  // open (nothing scrolls); wiring the prefetch to the viewer's index lets
  // prev/next walk the whole feed rather than being capped at whatever had been
  // loaded when it opened. The host's fetch is idempotent under its own in-flight
  // guard, so a redundant call here is harmless.
  useEffect(() => {
    if (loadMore && hasMore && !loading && index >= items.length - PREFETCH_MARGIN)
      loadMore();
  }, [index, items.length, hasMore, loading, loadMore]);

  // Prev/next stepper behind the buttons, arrow keys and swipe alike. When
  // `burstArrowNav` is on and the current item's pile is loaded, a step first
  // walks to the pile's next/previous frame (only swapping the displayed
  // media, like a filmstrip click); once at either end of the pile it falls
  // through to the normal host-index step. Off (the default), every step
  // moves the host index directly, so a pile is one stop — exactly like the
  // collapsed grid tile it came from.
  const stepNow = useCallback(
    (dir: 1 | -1) => {
      const it = items[index];
      if (burstArrowNav && burstMembers && burstMembers.length > 1 && it) {
        const curId = burstFrameId ?? it.id;
        const pos = burstMembers.findIndex((m) => m.id === curId);
        const nextPos = pos + dir;
        if (pos >= 0 && nextPos >= 0 && nextPos < burstMembers.length) {
          setShowCompanion(false);
          setShowCounterpart(false);
          const next = burstMembers[nextPos];
          setBurstFrameId(next.id === it.id ? null : next.id);
          return;
        }
      }
      onIndexChange(clamp(index + dir, 0, last));
    },
    [items, index, last, burstArrowNav, burstMembers, burstFrameId, onIndexChange],
  );

  // Public stepper — buttons, arrow keys and swipe all route through here.
  // While a committed swipe's slide is still landing, other navigation is
  // ignored (the settle timer performs that step itself, and a second step
  // arriving mid-flight would double-navigate).
  const stepBurst = useCallback(
    (dir: 1 | -1) => {
      if (settlingRef.current) return;
      stepNow(dir);
    },
    [stepNow],
  );

  // The media one step to either side of what's on screen — what a drag
  // reveals. Mirrors stepNow's routing exactly: with burst-aware nav on, the
  // pile's adjacent frame comes first; otherwise (or at the pile's edge) it's
  // the neighbouring list item. Null at the true end of the feed, where the
  // drag rubber-bands instead of revealing anything. `src` is null when the
  // neighbour exists but its derivative isn't ready (the pane shows the same
  // placeholder the stage would).
  const neighborFor = useCallback(
    (dir: 1 | -1): { key: string; src: string | null } | null => {
      const it = items[index];
      if (!it) return null;
      if (burstArrowNav && burstMembers && burstMembers.length > 1) {
        const curId = burstFrameId ?? it.id;
        const pos = burstMembers.findIndex((m) => m.id === curId);
        const nextPos = pos + dir;
        if (pos >= 0 && nextPos >= 0 && nextPos < burstMembers.length) {
          const m = burstMembers[nextPos];
          const mReady = m.derivative_status ? m.derivative_status === "ready" : true;
          return {
            key: `b${m.id}`,
            src: mReady ? `/api/assets/${m.id}/proxy` : null,
          };
        }
      }
      const n = items[index + dir];
      if (!n) return null;
      const nReady = n.derivative_status ? n.derivative_status === "ready" : true;
      return {
        key: `i${n.id}`,
        // A video neighbour previews as its poster during the slide; the real
        // <video> mounts once the step commits.
        src: !nReady ? null : n.media_type === "video" ? posterSrc(n) : mediaSrc(n),
      };
    },
    [items, index, burstArrowNav, burstMembers, burstFrameId, mediaSrc, posterSrc],
  );

  // Land a committed swipe: slide the track the rest of the way to the
  // revealed neighbour, then perform the actual step once the slide has
  // visually finished. Deferring the step means the index change and the
  // track's instant reset to centre happen in one render *after* the
  // animation — the neighbour that just slid in is repainted as the new
  // current media with no flicker (same URL, already decoded).
  const settleCommit = useCallback(
    (dir: 1 | -1) => {
      settlingRef.current = true;
      const w = (stageRef.current?.clientWidth ?? window.innerWidth) + PANE_GAP;
      setSwipe({ x: dir === 1 ? -w : w, settle: "commit" });
      settleTimer.current = window.setTimeout(() => {
        settlingRef.current = false;
        stepNow(dir);
        setSwipe({ x: 0, settle: null });
      }, SETTLE_MS);
    },
    [stepNow],
  );

  const zoomBy = useCallback(
    (factor: number) => setScale((s) => clamp(s * factor, MIN_SCALE, MAX_SCALE)),
    [],
  );

  // Clicking the zoom readout: from any zoom, snapshot it and fall back to fit;
  // from fit, restore the last snapshot (defaulting to 2× if none yet).
  const toggleZoom = useCallback(() => {
    if (scale > MIN_SCALE) {
      zoomMemory.current = { scale, tx, ty };
      setScale(MIN_SCALE);
      setTx(0);
      setTy(0);
    } else {
      const m = zoomMemory.current;
      setScale(m.scale > MIN_SCALE ? m.scale : 2);
      setTx(m.tx);
      setTy(m.ty);
    }
  }, [scale, tx, ty]);

  // Once back to fit, drop any leftover pan so the media re-centres.
  useEffect(() => {
    if (scale <= MIN_SCALE) {
      setTx(0);
      setTy(0);
    }
  }, [scale]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A viewer stacked on top of this one owns the keyboard (see viewerStack).
      if (viewerStack[viewerStack.length - 1] !== stackId.current) return;
      const it = items[index];
      if (!it) return;
      // Don't hijack keys while the user is typing in a field (e.g. a tag input).
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "Escape") return onClose();
      if (e.key === "ArrowRight") return stepBurst(1);
      if (e.key === "ArrowLeft") return stepBurst(-1);
      if (e.key === "i" || e.key === "I") return setPanel(!panelOpen);
      onKeyDown?.(e, it);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, index, stepBurst, onClose, onKeyDown, panelOpen, setPanel]);

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
    startT: 0, // touchstart timestamp — a fast release reads as a flick
    axis: "none" as "none" | "h" | "v", // locked-in direction of a swipe drag
  });

  const onTouchStart = (e: React.TouchEvent) => {
    const g = touch.current;
    if (e.touches.length === 2) {
      // A second finger promotes the gesture to a pinch; drop any half-dragged
      // swipe offset so the stage recentres under the zoom.
      if (swipe.x !== 0 && !settlingRef.current)
        setSwipe({ x: 0, settle: "cancel" });
      const [a, b] = [e.touches[0], e.touches[1]];
      g.mode = "pinch";
      g.startDist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      g.startScale = scale;
    } else if (e.touches.length === 1) {
      const t = e.touches[0];
      // Zoomed in → one finger pans; fitted → one finger drags the swipe
      // track. A commit slide mid-flight ignores new touches — the pending
      // step lands in ~a quarter second and the next drag starts clean.
      if (scale > MIN_SCALE) g.mode = "pan";
      else if (settlingRef.current) {
        g.mode = "none";
        return;
      } else g.mode = "swipe";
      g.startX = t.clientX;
      g.startY = t.clientY;
      g.startTx = tx;
      g.startTy = ty;
      g.startT = e.timeStamp;
      g.axis = "none";
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
    } else if (g.mode === "swipe" && e.touches.length === 1) {
      const t = e.touches[0];
      const dx = t.clientX - g.startX;
      const dy = t.clientY - g.startY;
      // Lock the drag's axis on its first few pixels: a mostly-vertical
      // movement is not a navigation gesture, so it releases the track
      // entirely rather than jiggling the photo sideways.
      if (g.axis === "none" && Math.hypot(dx, dy) >= AXIS_LOCK_PX) {
        g.axis = Math.abs(dx) > Math.abs(dy) ? "h" : "v";
        if (g.axis === "v") {
          g.mode = "none";
          return;
        }
      }
      if (g.axis === "h") {
        // Follow the finger 1:1. At the end of the feed there is nothing to
        // reveal, so the track resists instead — a short rubber-band.
        const stretch = neighborFor(dx < 0 ? 1 : -1) ? 1 : 0.25;
        setSwipe({ x: dx * stretch, settle: null });
      }
    }
  };

  const onTouchEnd = (e: React.TouchEvent) => {
    const g = touch.current;
    if (g.mode === "swipe" && g.axis === "h") {
      const t = e.changedTouches[0];
      const dx = t.clientX - g.startX;
      const dir: 1 | -1 = dx < 0 ? 1 : -1;
      // Commit on either a long-enough drag or a quick flick; otherwise (or
      // when there's nothing in that direction) spring back to centre.
      const flick = e.timeStamp - g.startT < FLICK_MS && Math.abs(dx) > FLICK_PX;
      if ((Math.abs(dx) > SWIPE_THRESHOLD || flick) && neighborFor(dir)) {
        settleCommit(dir);
      } else {
        setSwipe((s) => (s.x !== 0 ? { x: 0, settle: "cancel" } : s));
      }
    }
    if (e.touches.length === 0) g.mode = "none";
  };

  // The OS can steal a live touch (notification shade, app switch, incoming
  // call): touchend never fires, so spring any half-dragged track back to
  // centre rather than leaving it stuck mid-slide.
  const onTouchCancel = () => {
    const g = touch.current;
    if (g.mode === "swipe" && g.axis === "h")
      setSwipe((s) => (s.x !== 0 ? { x: 0, settle: "cancel" } : s));
    g.mode = "none";
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
  // iPhone Live Photo: the still is on screen and its .mov motion is one tap away
  // (the on-image LIVE badge below + the format toggle in the controls bar).
  const isLive = item.group_kind === "live_photo" && hasCompanion;

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

  // Burst/bracket pile: a filmstrip frame other than the item itself, picked
  // for preview. Bursts cluster photos only (cf. lib/bursts.ts), so this is
  // always a still — no video/companion handling needed for it.
  const burstFrame =
    burstFrameId != null
      ? (burstMembers?.find((m) => m.id === burstFrameId) ?? null)
      : null;
  const burstFrameReady = burstFrame
    ? burstFrame.derivative_status
      ? burstFrame.derivative_status === "ready"
      : true
    : false;
  // Whichever media is on screen — the item or a previewed burst frame — is
  // ready to display.
  const showable = burstFrame ? burstFrameReady : ready;

  // This item's position within its pile, only meaningful once burst-aware
  // arrow nav is on — drives whether the prev/next buttons still have a step
  // left to take even at the host list's own boundary (index 0 / last).
  const burstPos =
    burstArrowNav && burstMembers
      ? burstMembers.findIndex((m) => m.id === (burstFrameId ?? item.id))
      : -1;
  const canStepBackInPile = burstPos > 0;
  const canStepFwdInPile = burstPos >= 0 && burstPos < (burstMembers?.length ?? 0) - 1;

  const currentSrc = burstFrame
    ? `/api/assets/${burstFrame.id}/proxy`
    : counterpartShown
      ? `/api/assets/${counterpartId}/proxy`
      : companionShown
        ? `/api/assets/${item.companion_id}/proxy`
        : mediaSrc(item);

  // The file actually on screen. EXIF (date/camera/exposure/GPS) is shared
  // across a pair, so only the file-level fields — name, type, size, dimensions
  // and path — switch to the companion's when the RAW side is displayed. This
  // keeps the header and metadata panel describing what you're looking at rather
  // than always the primary.
  const displayed: AssetMetaInput & { filename: string } = burstFrame
    ? burstFrame
    : counterpartShown
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

  // --- Faces (cf. lib/people.ts) --------------------------------------------
  // The current asset's detected faces: chips in the info panel, boundaries on
  // the media itself (hover a chip or the face to reveal its box; clicking a
  // box opens that person's page). Photos only — boxes over a playing video
  // would be nonsense, and the analysis ran on the photo proxy anyway.
  const [faces, setFaces] = useState<ViewerFace[] | null>(null);
  const [activeFaceId, setActiveFaceId] = useState<number | null>(null);
  useEffect(() => {
    setFaces(null);
    setActiveFaceId(null);
    if (item.media_type === "video") return;
    let alive = true;
    fetchJson<{ faces: ViewerFace[] }>(`/api/assets/${item.id}/faces`)
      .then((d) => {
        if (alive) setFaces(d.faces);
      })
      .catch(() => {
        /* no chips/boxes — the media itself is unaffected */
      });
    return () => {
      alive = false;
    };
  }, [item.id, item.media_type]);

  // The face layer must sit exactly over the displayed image. offsetWidth/
  // offsetLeft give the image's UNtransformed layout box relative to its
  // positioned ancestor (.stage-pane); the layer then wears the very same
  // transform as the image, so it tracks zoom/pan with no re-measurement.
  const mainImgRef = useRef<HTMLImageElement | null>(null);
  const [imgBox, setImgBox] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const measureImg = useCallback(() => {
    const el = mainImgRef.current;
    if (!el || el.offsetWidth === 0 || el.offsetHeight === 0) {
      setImgBox(null);
      return;
    }
    setImgBox({
      left: el.offsetLeft,
      top: el.offsetTop,
      width: el.offsetWidth,
      height: el.offsetHeight,
    });
  }, []);
  useEffect(() => {
    measureImg();
    const el = mainImgRef.current;
    if (!el) return;
    const ro = new ResizeObserver(measureImg);
    ro.observe(el);
    window.addEventListener("resize", measureImg);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measureImg);
    };
    // Re-hooked whenever the displayed media changes shape or the layout
    // around it does (panel toggle re-flows the stage).
  }, [measureImg, index, panelOpen, ready]);

  // Boundaries only over the item's OWN photo: a companion (RAW side), an
  // edit counterpart or a burst sibling is a different image than the one the
  // boxes were measured on.
  const faceLayerOn =
    !burstFrame &&
    !companionShown &&
    !counterpartShown &&
    item.media_type !== "video" &&
    (faces?.length ?? 0) > 0;

  // The two neighbour panes riding the swipe track beside the current media.
  // Always rendered (not just mid-drag): offscreen they double as a preload of
  // the adjacent proxies, so both a drag's reveal and a committed step paint
  // instantly from cache.
  const prevNeighbor = neighborFor(-1);
  const nextNeighbor = neighborFor(1);

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
          onClick={() => setPanel(true)}
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
          onTouchCancel={onTouchCancel}
          onDoubleClick={onDoubleClick}
          onContextMenu={onContextMenu ? (e) => onContextMenu(e, item) : undefined}
        >
          {/* Swipe track: prev · current · next, translated as one strip so a
              one-finger drag slides the current media out while the neighbour
              slides in (see the swipe state above). Badges and the zoom HUD
              stay outside so they hold still while the media moves. */}
          <div
            className={`stage-track${swipe.settle ? " is-settling" : ""}`}
            style={{ transform: `translate3d(${swipe.x}px, 0, 0)` }}
          >
            {prevNeighbor && (
              <div className="stage-pane is-prev" aria-hidden>
                {prevNeighbor.src ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={prevNeighbor.key} src={prevNeighbor.src} alt="" draggable={false} />
                ) : (
                  <div className="placeholder">Derivative unavailable</div>
                )}
              </div>
            )}
            <div className="stage-pane">
              {burstFrame ? (
                burstFrameReady ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={`b${burstFrame.id}`}
                    src={currentSrc}
                    alt={displayed.filename}
                    style={transform}
                  />
                ) : (
                  <div className="placeholder">Derivative unavailable</div>
                )
              ) : ready ? (
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
                    ref={mainImgRef}
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
                    onLoad={measureImg}
                  />
                )
              ) : (
                <div className="placeholder">Derivative unavailable</div>
              )}
              {faceLayerOn && imgBox && (
                // Face boundaries, projected from analyzed-image pixels onto
                // the displayed image (percentages of a congruent layer).
                // Boxes are invisible until hovered — or forced visible by
                // hovering their chip in the info panel; a click opens the
                // person's page. mousedown/touchstart stop here so grabbing a
                // face never starts a pan/swipe.
                <div
                  className="face-layer"
                  style={{
                    left: imgBox.left,
                    top: imgBox.top,
                    width: imgBox.width,
                    height: imgBox.height,
                    transform: transform.transform,
                    transformOrigin: "center center",
                  }}
                >
                  {faces!.map((f) => {
                    if (!f.img_width || !f.img_height) return null;
                    const style = {
                      left: `${(f.x1 / f.img_width) * 100}%`,
                      top: `${(f.y1 / f.img_height) * 100}%`,
                      width: `${((f.x2 - f.x1) / f.img_width) * 100}%`,
                      height: `${((f.y2 - f.y1) / f.img_height) * 100}%`,
                    };
                    const cls = `face-box${activeFaceId === f.id ? " active" : ""}`;
                    const label = f.person_name ?? "Unnamed";
                    const hover = {
                      onMouseEnter: () => setActiveFaceId(f.id),
                      onMouseLeave: () =>
                        setActiveFaceId((cur) => (cur === f.id ? null : cur)),
                      onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
                      onTouchStart: (e: React.TouchEvent) => e.stopPropagation(),
                    };
                    return f.person_id != null ? (
                      <Link
                        key={f.id}
                        href={`/people/${f.person_id}`}
                        className={cls}
                        style={style}
                        title={`${label} — open their page`}
                        {...hover}
                      >
                        <span className="face-box-label">{label}</span>
                      </Link>
                    ) : (
                      <span key={f.id} className={cls} style={style} {...hover}>
                        <span className="face-box-label">{label}</span>
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
            {nextNeighbor && (
              <div className="stage-pane is-next" aria-hidden>
                {nextNeighbor.src ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={nextNeighbor.key} src={nextNeighbor.src} alt="" draggable={false} />
                ) : (
                  <div className="placeholder">Derivative unavailable</div>
                )}
              </div>
            )}
          </div>
          {isLive && showable && !counterpartShown && !burstFrame && (
            // Apple-style LIVE badge sitting on the image: tap to swap between the
            // still and its motion. Mirrors the format toggle in the controls bar.
            <button
              type="button"
              className={`viewer-live-badge${companionShown ? " active" : ""}${
                !panelOpen ? " below-info" : ""
              }`}
              aria-pressed={companionShown}
              title={companionShown ? "Show the still" : "Play the Live Photo motion"}
              onMouseDown={stopVideoMouse}
              onClick={() => setShowCompanion((s) => !s)}
            >
              <span className="live-badge-dot" aria-hidden />
              LIVE
            </button>
          )}
          {(item.burst_count ?? 0) > 1 && (
            // Pile size (bottom-left of the stage), mirroring the grid's
            // collapsed-cover badge — informational only, the filmstrip below
            // is what actually browses the other frames.
            <div
              className="viewer-burst-badge"
              title={`Burst pile of ${item.burst_count} frames`}
            >
              ⧉ {item.burst_count}
            </div>
          )}
          {showable && (
            // Zoom HUD (bottom-right of the stage): −, the live zoom readout, +.
            // The readout is itself a button — click to pop back to fit, click
            // again to return to the last zoom. Stop pointer/touch events from
            // reaching the stage so its buttons never start a pan, a swipe or a
            // double-click zoom.
            <div
              className="viewer-zoom"
              role="group"
              aria-label="Zoom"
              onMouseDown={stopVideoMouse}
              onDoubleClick={(e) => e.stopPropagation()}
              onTouchStart={stopVideoTouch}
            >
              <button
                type="button"
                className="viewer-zoom-btn"
                onClick={() => zoomBy(1 / 1.15)}
                disabled={scale <= MIN_SCALE}
                aria-label="Zoom out"
                title="Zoom out"
              >
                −
              </button>
              <button
                type="button"
                className="viewer-zoom-level"
                onClick={toggleZoom}
                aria-label={
                  scale > MIN_SCALE ? "Reset zoom to fit" : "Restore last zoom"
                }
                title={
                  scale > MIN_SCALE ? "Reset to fit" : "Restore last zoom"
                }
              >
                {Math.round(scale * 100)}%
              </button>
              <button
                type="button"
                className="viewer-zoom-btn"
                onClick={() => zoomBy(1.15)}
                disabled={scale >= MAX_SCALE}
                aria-label="Zoom in"
                title="Zoom in"
              >
                +
              </button>
            </div>
          )}
        </div>
        {burstMembers && burstMembers.length > 1 && (
          // Horizontal filmstrip of the pile's other frames — sits under the
          // stage (and above the info panel, whether or not it's open) so
          // browsing a burst never requires leaving the viewer or expanding the
          // grid. Picking a frame only swaps what's on screen (see burstFrame
          // above). The leading toggle opts prev/next/swipe into stepping
          // through these same frames too (see stepBurst) — off by default so
          // arrow navigation stays one photo per press.
          <div className="viewer-burst-strip" role="group" aria-label="Burst frames">
            <button
              type="button"
              className={`viewer-burst-nav-toggle${burstArrowNav ? " active" : ""}`}
              aria-pressed={burstArrowNav}
              title={
                burstArrowNav
                  ? "Arrow keys, swipe and prev/next step through this pile's frames — click to stop"
                  : "Include this pile's frames when navigating with ← → / swipe"
              }
              onClick={() => setBurstArrowNav((v) => !v)}
            >
              ⇄
            </button>
            <div className="viewer-burst-thumbs">
              {burstMembers.map((m) => {
                const active = (burstFrameId ?? item.id) === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    className={`viewer-burst-thumb${active ? " active" : ""}`}
                    aria-pressed={active}
                    title={m.filename}
                    onClick={() => {
                      setShowCompanion(false);
                      setShowCounterpart(false);
                      setBurstFrameId(m.id === item.id ? null : m.id);
                    }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/api/assets/${m.id}/thumb`} alt={m.filename} loading="lazy" />
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {panelOpen && (
          <aside className="viewer-panel">
            <div className="viewer-panel-head">
              <strong className="viewer-panel-name" title={displayed.filename}>
                {displayed.filename}
              </strong>
              <button
                className="viewer-panel-toggle"
                onClick={() => setPanel(false)}
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
                  onClick={() => {
                    setBurstFrameId(null);
                    setShowCompanion(false);
                  }}
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
                    setBurstFrameId(null);
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
                  onClick={() => {
                    setBurstFrameId(null);
                    setShowCounterpart(false);
                  }}
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
                    setBurstFrameId(null);
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
            {(faces?.length ?? 0) > 0 && (
              // Who is in frame (cf. lib/people.ts): one chip per detected
              // face, linking to the person's page. Hovering a chip lights up
              // that face's boundary on the media (and vice versa).
              <div className="viewer-faces">
                <div className="viewer-pair-label">
                  {faces!.length === 1 ? "1 face" : `${faces!.length} faces`}
                </div>
                <div className="chips">
                  {faces!.map((f) => {
                    const label = f.person_name ?? "Unnamed";
                    const cls = `chip person-chip${activeFaceId === f.id ? " active" : ""}`;
                    const crop = (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        className="chip-face"
                        src={`/api/faces/${f.id}/thumb`}
                        alt=""
                        loading="lazy"
                      />
                    );
                    const hover = {
                      onMouseEnter: () => setActiveFaceId(f.id),
                      onMouseLeave: () =>
                        setActiveFaceId((cur) => (cur === f.id ? null : cur)),
                    };
                    return f.person_id != null ? (
                      <Link
                        key={f.id}
                        href={`/people/${f.person_id}`}
                        className={cls}
                        title={`${label} — open their page`}
                        {...hover}
                      >
                        {crop}
                        {label}
                      </Link>
                    ) : (
                      <span key={f.id} className={cls} title={label} {...hover}>
                        {crop}
                        {label}
                      </span>
                    );
                  })}
                </div>
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
              onClick={() => {
                setBurstFrameId(null);
                setShowCompanion(false);
              }}
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
              onClick={() => {
                setBurstFrameId(null);
                setShowCompanion(true);
              }}
            >
              {item.group_kind === "live_photo"
                ? "LIVE"
                : fmtExt(item.companion_ext)}
            </button>
          </div>
        )}
        <button
          className="btn"
          onClick={() => stepBurst(-1)}
          disabled={index === 0 && !canStepBackInPile}
          aria-label="Previous"
        >
          ←
        </button>
        {renderActions?.(item)}
        <button
          className="btn"
          onClick={() => stepBurst(1)}
          // Only the true end of the feed (no further pages, and no further
          // frame left in the pile when burst-aware nav is on) disables Next;
          // at the edge of the loaded window the prefetch above is already
          // pulling more.
          disabled={index === last && !hasMore && !canStepFwdInPile}
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
