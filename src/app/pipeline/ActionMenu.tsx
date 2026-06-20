"use client";

// Compact overflow menu: a "⋯" trigger that drops a list of secondary/
// destructive actions. Keeps row toolbars tidy (one button instead of a sprawl)
// and works well on mobile where inline action clusters wrap awkwardly. The menu
// is fixed-positioned next to the trigger and clamped to the viewport.
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Icons } from "../ui";

export type MenuItem = {
  key: string;
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
};

export default function ActionMenu({
  items,
  label,
  ariaLabel = "More actions",
  disabled,
}: {
  items: MenuItem[];
  /** Optional heading shown at the top of the menu. */
  label?: string;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  // Place the menu just under the trigger, right-aligned, flipped/clamped so it
  // always stays on screen.
  useLayoutEffect(() => {
    if (!open) return;
    const t = triggerRef.current?.getBoundingClientRect();
    if (!t) return;
    const m = menuRef.current?.getBoundingClientRect();
    const width = m?.width ?? 200;
    const height = m?.height ?? 0;
    let x = t.right - width;
    let y = t.bottom + 6;
    x = Math.max(8, Math.min(x, window.innerWidth - width - 8));
    if (height && y + height > window.innerHeight - 8) {
      y = Math.max(8, t.top - height - 6);
    }
    setPos({ x, y });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      if (triggerRef.current?.contains(e.target as Node)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  if (items.length === 0) return null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`btn btn-sm btn-icon${open ? " is-open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        {Icons.more}
      </button>

      {open && (
        <div
          ref={menuRef}
          className="ctx-menu"
          role="menu"
          style={{
            left: pos?.x ?? -9999,
            top: pos?.y ?? -9999,
            visibility: pos ? "visible" : "hidden",
          }}
        >
          {label && <div className="ctx-label">{label}</div>}
          {items.map((it) => (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              className={`ctx-item${it.danger ? " ctx-danger" : ""}`}
              disabled={it.disabled}
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
            >
              {it.icon != null && <span className="ctx-ic">{it.icon}</span>}
              {it.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
