"use client";

// Pull-to-refresh: wrap a scrollable view's content and it adds the familiar
// "drag down at the top to reload" gesture for touch devices. The component
// finds its nearest scrollable ancestor (e.g. .tab-body / .pipeline-body /
// .root-main) and watches for a downward drag that begins while that scroller
// is pinned to the top; past a threshold it runs `onRefresh` and shows a
// spinner until the returned promise settles. It is inert with a mouse (touch
// only), so desktop behaviour is unchanged.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { cn } from "@/lib/cn";

const THRESHOLD = 64; // px of pull needed to commit a refresh
const MAX_PULL = 96; // px the indicator can travel (rubber-banded)
const RESISTANCE = 0.5; // drag-to-travel ratio (the rubber band)
const DEADZONE = 6; // px before a drag counts as an intentional pull

// Resolve the vertical scroller, starting at the element itself (the wrapper is
// sometimes the scroller — e.g. .sessions-pane — and sometimes just sits inside
// one — e.g. .pipeline-body). Matches on the computed overflow (not the current
// scrollHeight) so a not-yet-overflowing list — content still loading — still
// resolves to its eventual scroller.
function findScroller(el: HTMLElement | null): HTMLElement | null {
  let node = el;
  while (node) {
    const oy = getComputedStyle(node).overflowY;
    if (oy === "auto" || oy === "scroll" || oy === "overlay") return node;
    node = node.parentElement;
  }
  return null;
}

export default function PullToRefresh({
  onRefresh,
  children,
  className,
  style,
  disabled = false,
  scrollerRef,
}: {
  /** Reload callback; the spinner spins until the returned promise settles. */
  onRefresh: () => Promise<unknown> | void;
  children: ReactNode;
  /** Forwarded to the wrapper so it can keep the host's layout class. */
  className?: string;
  /** Forwarded to the wrapper (the indicator stays anchored regardless). */
  style?: CSSProperties;
  disabled?: boolean;
  /**
   * Optional: receives the scroll container. The wrapper *is* the scroller when
   * the host forwards an `overflow` class (e.g. `.sessions-pane`), so a host
   * that needs to read/restore the scroll offset can grab it through this.
   */
  scrollerRef?: RefObject<HTMLDivElement | null>;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  // Merge our internal ref with the host's optional one onto the same node.
  const setRoot = useCallback(
    (el: HTMLDivElement | null) => {
      rootRef.current = el;
      if (scrollerRef) scrollerRef.current = el;
    },
    [scrollerRef],
  );
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  // `snap` toggles the CSS transition: off while the finger drives the
  // indicator (so it tracks 1:1), on when we animate the release/return.
  const [snap, setSnap] = useState(true);

  // Mutable gesture state kept in refs so the listeners stay stable.
  const startY = useRef(0);
  const startX = useRef(0);
  const tracking = useRef(false); // touch began at the top
  const engaged = useRef(false); // committed to a vertical pull
  const pullRef = useRef(0);
  const refreshingRef = useRef(false);
  refreshingRef.current = refreshing;
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  useEffect(() => {
    if (disabled) return;
    const root = rootRef.current;
    if (!root) return;
    const scroller = findScroller(root);
    if (!scroller) return;

    const reset = () => {
      setSnap(true);
      setPull(0);
      pullRef.current = 0;
    };

    const onStart = (e: TouchEvent) => {
      if (refreshingRef.current || e.touches.length !== 1) return;
      if (scroller.scrollTop > 0) return;
      tracking.current = true;
      engaged.current = false;
      startY.current = e.touches[0].clientY;
      startX.current = e.touches[0].clientX;
    };

    const onMove = (e: TouchEvent) => {
      if (!tracking.current || refreshingRef.current) return;
      const dy = e.touches[0].clientY - startY.current;
      const dx = e.touches[0].clientX - startX.current;
      if (!engaged.current) {
        // Only commit once the drag is clearly a downward pull from the top —
        // an upward or sideways move hands control back to the scroller.
        if (dy <= 0 || Math.abs(dx) > Math.abs(dy) || scroller.scrollTop > 0) {
          tracking.current = false;
          return;
        }
        if (dy < DEADZONE) return;
        engaged.current = true;
        setSnap(false);
      }
      const dist = Math.min(MAX_PULL, dy * RESISTANCE);
      if (dist <= 0) {
        setPull(0);
        pullRef.current = 0;
        return;
      }
      // We own the gesture now — stop the scroller from rubber-banding too.
      e.preventDefault();
      pullRef.current = dist;
      setPull(dist);
    };

    const onEnd = () => {
      if (!tracking.current) return;
      tracking.current = false;
      const committed = engaged.current;
      engaged.current = false;
      if (!committed) return;
      if (pullRef.current >= THRESHOLD && !refreshingRef.current) {
        setSnap(true);
        setRefreshing(true);
        setPull(THRESHOLD);
        pullRef.current = THRESHOLD;
        Promise.resolve(onRefreshRef.current())
          .catch(() => {})
          .finally(() => {
            setRefreshing(false);
            reset();
          });
      } else {
        reset();
      }
    };

    scroller.addEventListener("touchstart", onStart, { passive: true });
    scroller.addEventListener("touchmove", onMove, { passive: false });
    scroller.addEventListener("touchend", onEnd);
    scroller.addEventListener("touchcancel", onEnd);
    return () => {
      scroller.removeEventListener("touchstart", onStart);
      scroller.removeEventListener("touchmove", onMove);
      scroller.removeEventListener("touchend", onEnd);
      scroller.removeEventListener("touchcancel", onEnd);
    };
  }, [disabled]);

  const progress = Math.min(1, pull / THRESHOLD);
  const active = pull > 0 || refreshing;

  return (
    <div ref={setRoot} className={cn("ptr", className)} style={style}>
      <div
        className={cn("ptr-indicator", refreshing && "is-refreshing")}
        aria-hidden={!active}
        style={{
          transform: `translateY(${pull}px) scale(${0.7 + 0.3 * progress})`,
          opacity: refreshing ? 1 : progress,
          transition: snap
            ? "transform 0.25s var(--ease-out, ease-out), opacity 0.2s"
            : "none",
        }}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={
            refreshing
              ? undefined
              : { transform: `rotate(${progress * 270}deg)` }
          }
        >
          <path d="M21 12a9 9 0 1 1-2.64-6.36" />
          <path d="M21 4v5h-5" />
        </svg>
      </div>
      {children}
    </div>
  );
}
