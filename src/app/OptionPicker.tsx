"use client";

// One control for "pick one of N", whatever N is.
//
// The project has ~20 segmented groups and, until /gear grew to eight layouts,
// every one of them held two to four options — which is what a segmented control
// is for. At eight it overflowed a phone and pushed the last two options off the
// screen with nothing to reveal they existed; `flex-wrap` made them reachable at
// the cost of two rows of chrome and of the control still reading as one row of
// segments.
//
// So the form follows the OPTION COUNT, not the viewport: segments while they
// fit on any screen, a menu past that. A count rather than a measurement because
// it is deterministic — it renders the same on the server and the client, needs
// no ResizeObserver, and cannot change under the fingers while the page settles.
// (The heuristic's limit is stated at SEGMENT_MAX.)
//
// Two things make the swap safe for the twenty existing call sites: the segments
// form emits the project's existing markup verbatim, so every contextual
// override (`.gallery-controls .view-btn`, `.facet-head`, `.pl-toolbar`,
// `.sift-controls`) keeps applying untouched; and the menu form wears the
// `.view-toggle` shell for its trigger and the `.ctx-menu` skin for its panel,
// so it reads as a member of the same family rather than a foreign widget.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPanel } from "./useAnchoredPanel";

export type PickerOption<K extends string> = {
  key: K;
  /** What the segment says, and what the trigger shows once chosen. */
  label: string;
  /**
   * One sentence about what this option does. It is the segment's `title` and
   * the menu item's second line — and the second line is the reason the menu
   * form is worth having: a `title` does not exist on a touch screen, so an
   * eight-option segmented control on a phone is eight unexplained words.
   */
  hint?: string;
  /** A population badge, the way /people and the dedup triage tabs carry one. */
  count?: number;
};

/**
 * The most options a segmented row can hold and still fit the narrowest screen
 * the app supports. Above this the control becomes a menu.
 *
 * It is a count, not a measurement: four short labels fit a 320px phone, and
 * every group in the project except gear's layouts has at most four. A group of
 * four VERY long labels would still overflow — `ThumbStrip`'s ResizeObserver is
 * the escape hatch if that ever shows up, deliberately not built for a case
 * that does not exist yet.
 */
const SEGMENT_MAX = 4;

const Caret = () => (
  <span className="menu-caret" aria-hidden>
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  </span>
);

const Check = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="3"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

type Props<K extends string> = {
  options: PickerOption<K>[];
  value: K;
  onChange: (key: K) => void;
  ariaLabel: string;
  /** `md` is the `.tabs` scale, `sm` the `.view-toggle` one. */
  size?: "sm" | "md";
  form?: "auto" | "segments" | "menu";
};

export function OptionPicker<K extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  size = "sm",
  form = "auto",
}: Props<K>) {
  const asMenu = form === "menu" || (form === "auto" && options.length > SEGMENT_MAX);
  return asMenu ? (
    <MenuForm
      options={options}
      value={value}
      onChange={onChange}
      ariaLabel={ariaLabel}
      size={size}
    />
  ) : (
    <SegmentsForm
      options={options}
      value={value}
      onChange={onChange}
      ariaLabel={ariaLabel}
      size={size}
    />
  );
}

/** The row of segments, in the project's own markup — `.tabs`/`.tab` at `md`,
 *  `.view-toggle`/`.view-btn` at `sm`. Nothing here is new; the point is that
 *  a call site can move to this component without moving a pixel. */
function SegmentsForm<K extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  size,
}: Omit<Props<K>, "form">) {
  const group = size === "md" ? "tabs" : "view-toggle";
  const item = size === "md" ? "tab" : "view-btn";
  return (
    <div className={group} role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          className={`${item}${o.key === value ? " active" : ""}`}
          onClick={() => onChange(o.key)}
          aria-pressed={o.key === value}
          title={o.hint}
        >
          {o.label}
          {o.count != null && <span className="tab-count">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

/**
 * The compact form: a trigger carrying the current label, and a listbox.
 *
 * A LISTBOX rather than a menu — this picks a value, it does not run an action —
 * so the roles are `listbox`/`option` with `aria-selected`, and the keyboard is
 * the one a listbox owes: arrows with wrap-around, Home/End, Enter to commit,
 * Escape to close and hand focus back. No other menu in this codebase does the
 * arrow keys or the focus return; this is the one that should.
 */
function MenuForm<K extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  size,
}: Omit<Props<K>, "form">) {
  const [open, setOpen] = useState(false);
  // Which option the keyboard is on. Separate from `value`: moving through the
  // list must not change the page behind it until Enter.
  const [active, setActive] = useState(0);
  const itemsRef = useRef<(HTMLButtonElement | null)[]>([]);
  // Left-aligned: the trigger states the current value, so the panel reads as
  // dropping out of it rather than hanging off its right edge.
  const { triggerRef, panelRef, style, placed } = useAnchoredPanel<HTMLDivElement>(
    open,
    () => setOpen(false),
    "left",
  );

  const current = options.find((o) => o.key === value) ?? options[0];
  const currentIndex = Math.max(
    0,
    options.findIndex((o) => o.key === value),
  );

  // Opening lands on the current option, and the focus follows — otherwise the
  // panel opens with the keyboard nowhere and the first arrow press jumps to
  // the top of a list you were already partway down.
  useEffect(() => {
    if (open) setActive(currentIndex);
  }, [open, currentIndex]);
  // `placed`, not just `open`: the panel spends its first frame measured-but-
  // hidden, and focusing a hidden element does nothing at all.
  useEffect(() => {
    if (open && placed) itemsRef.current[active]?.focus();
  }, [open, placed, active]);

  const commit = (key: K) => {
    setOpen(false);
    triggerRef.current?.focus();
    onChange(key);
  };

  const onListKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const n = options.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % n);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + n) % n);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(n - 1);
    } else if (e.key === "Escape") {
      // The hook closes on Escape too, but only it can return the focus.
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    }
  };

  if (options.length === 0) return null;

  return (
    <>
      <div className={size === "md" ? "tabs opt-picker" : "view-toggle opt-picker"}>
        <button
          ref={triggerRef}
          type="button"
          className={`opt-trigger${open ? " is-open" : ""}`}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={`${ariaLabel}: ${current?.label ?? ""}`}
          onClick={() => setOpen((o) => !o)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && !open) {
              e.preventDefault();
              setOpen(true);
            }
          }}
        >
          <span className="opt-eyebrow">{ariaLabel}</span>
          <span className="opt-value">{current?.label}</span>
          <Caret />
        </button>
      </div>

      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={panelRef}
            className="opt-list"
            role="listbox"
            aria-label={ariaLabel}
            style={style}
            onKeyDown={onListKeyDown}
          >
            {options.map((o, i) => (
              <button
                key={o.key}
                ref={(el) => {
                  itemsRef.current[i] = el;
                }}
                type="button"
                role="option"
                aria-selected={o.key === value}
                tabIndex={i === active ? 0 : -1}
                className={`opt-option${o.key === value ? " is-current" : ""}`}
                onClick={() => commit(o.key)}
              >
                <span className="opt-check">{o.key === value && <Check />}</span>
                <span className="opt-text">
                  <span className="opt-name">
                    {o.label}
                    {o.count != null && <span className="tab-count">{o.count}</span>}
                  </span>
                  {o.hint && <span className="opt-hint">{o.hint}</span>}
                </span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
