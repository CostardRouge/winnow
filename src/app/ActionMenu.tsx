"use client";

// Compact dropdown menu: a trigger button that drops a list of ACTIONS. Used for
// row overflow menus (a "⋯" kebab) and for grouping several download options
// behind one labelled button.
//
// The placement and the dismissal live in `useAnchoredPanel` — shared with the
// OptionPicker's menu form, which is the same floating panel around a listbox of
// values rather than a list of actions.
import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPanel } from "./useAnchoredPanel";
import { Icons } from "./ui";

export type MenuItem = {
  key: string;
  label: string;
  icon?: ReactNode;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
};

export default function ActionMenu({
  items,
  label,
  ariaLabel = "More actions",
  disabled,
  trigger,
}: {
  items: MenuItem[];
  /** Optional heading shown at the top of the menu. */
  label?: string;
  ariaLabel?: string;
  disabled?: boolean;
  /** Customise the trigger button. Defaults to a "⋯" icon button. */
  trigger?: { label?: string; icon?: ReactNode; className?: string };
}) {
  const [open, setOpen] = useState(false);
  // Right-aligned: these menus hang off a "⋯" button at the end of a row.
  const { triggerRef, panelRef, style } = useAnchoredPanel<HTMLDivElement>(
    open,
    () => setOpen(false),
  );

  if (items.length === 0) return null;

  const triggerClass = trigger?.className ?? "btn btn-sm btn-icon";
  const triggerIcon = trigger?.icon ?? Icons.more;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`${triggerClass}${open ? " is-open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        {triggerIcon}
        {trigger?.label && (
          <>
            <span className="seg-label">{trigger.label}</span>
            <span className="menu-caret" aria-hidden>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </span>
          </>
        )}
      </button>

      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div ref={panelRef} className="ctx-menu" role="menu" style={style}>
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
                <span className="ctx-item-text">
                  {it.label}
                  {it.hint && <span className="ctx-item-hint">{it.hint}</span>}
                </span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
