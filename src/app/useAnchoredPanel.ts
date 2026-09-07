"use client";

// Anchoring a floating panel to the button that opened it — the part every
// dropdown in this app needs and none of them should own twice.
//
// It was `ActionMenu`'s alone until a second control (the OptionPicker's menu
// form) needed the same four behaviours, and a second copy of viewport-clamping
// arithmetic is exactly the drift `LibrarySourceTabs` was extracted to stop
// (cf. docs/memory/frontend.md). The hook owns the *placement and dismissal*;
// the open state, the markup and the ARIA roles stay with the component, since
// a menu of actions and a listbox of values disagree about all three.
//
// The panel is fixed-positioned and meant to be rendered through a portal into
// <body>: a transformed ancestor (a card's hover lift) would otherwise become
// the containing block for `position: fixed` and drag the panel away from its
// trigger. That is also why a scroll anywhere closes it — a fixed panel does
// not follow a scrolling ancestor.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/** What the panel needs to paint itself in the right place. Spread onto its
 *  `style`: until the first measure lands it is parked off-screen and hidden,
 *  so nothing flashes at the top-left corner on the frame before placement. */
export type PanelStyle = {
  left: number;
  top: number;
  visibility: "hidden" | "visible";
};

export type AnchoredPanel<T extends HTMLElement> = {
  triggerRef: RefObject<HTMLButtonElement | null>;
  panelRef: RefObject<T | null>;
  style: PanelStyle;
  /**
   * True once the panel has been measured and placed — i.e. once it is actually
   * visible. Anything that touches the panel's DOM must wait for it: calling
   * `.focus()` on the frame before placement is a silent no-op, because the
   * panel is still `visibility: hidden` and a hidden element cannot take focus.
   * That cost the picker its whole keyboard path until it was measured.
   */
  placed: boolean;
};

/** Keep the panel this far from every edge of the viewport. */
const GUTTER = 8;
/** And this far below (or above) its trigger. */
const OFFSET = 6;

/**
 * Position a panel under `triggerRef` and close it on anything that would leave
 * it stranded. `onClose` fires on a press outside, Escape, a resize, or a scroll
 * anywhere in the page — it never fires while the panel is closed.
 *
 * `align` picks which edge the panel shares with its trigger: menus hanging off
 * a "⋯" button read better right-aligned, a picker whose trigger carries the
 * current value reads better left-aligned under it. Either way the result is
 * clamped into the viewport, and flipped above the trigger when it would run off
 * the bottom.
 */
export function useAnchoredPanel<T extends HTMLElement>(
  open: boolean,
  onClose: () => void,
  align: "left" | "right" = "right",
): AnchoredPanel<T> {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<T>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  // Reset on close so the next opening measures again rather than flashing at
  // wherever the panel was last time — the trigger may have moved since.
  useEffect(() => {
    if (!open) setPos(null);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const t = triggerRef.current?.getBoundingClientRect();
    if (!t) return;
    const p = panelRef.current?.getBoundingClientRect();
    const width = p?.width ?? 200;
    const height = p?.height ?? 0;

    let x = align === "right" ? t.right - width : t.left;
    let y = t.bottom + OFFSET;
    x = Math.max(GUTTER, Math.min(x, window.innerWidth - width - GUTTER));
    if (height && y + height > window.innerHeight - GUTTER) {
      y = Math.max(GUTTER, t.top - height - OFFSET);
    }
    setPos({ x, y });
  }, [open, align]);

  // Held in a ref so the listeners depend on `open` alone. With `onClose` in the
  // dependency list, a caller passing an inline arrow (which every caller does)
  // would tear down and re-attach all four listeners on every render.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const close = () => closeRef.current();
    const onDown = (e: MouseEvent) => {
      if (panelRef.current?.contains(e.target as Node)) return;
      if (triggerRef.current?.contains(e.target as Node)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    // Capture: a scroll inside any container has to close it too, and scroll
    // events from a scrolling element do not bubble to window.
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  return {
    triggerRef,
    panelRef,
    placed: pos != null,
    style: {
      left: pos?.x ?? -9999,
      top: pos?.y ?? -9999,
      visibility: pos ? "visible" : "hidden",
    },
  };
}
