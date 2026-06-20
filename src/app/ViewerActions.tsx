"use client";

import { useEffect, useRef, useState } from "react";
import type { Verdict } from "@/lib/types";

// The viewer's action bar, grouped by intent instead of a flat row of buttons:
//   [ ✕ Reject | ✓ Pick ]   ★★★★★   [ ⋯ More ▾ ]
//
//  - Verdict is a two-segment toggle: clicking the *active* verdict clears it
//    back to "unrated" (so a pick/reject is reversible without a separate
//    "clear" button). Stars toggle the same way — clicking the current rating
//    drops it to 0.
//  - Secondary, lower-frequency actions (tag, export, regenerate, delete) move
//    into an overflow menu so the bar stays calm.
//
// Shared by every full-screen viewer (the gallery lightbox and the session
// triage viewer) so the culling controls read identically everywhere.
export default function ViewerActions({
  verdict,
  star,
  onVerdict,
  onStar,
  onExport,
  onRegenerate,
  onDelete,
  onTag,
}: {
  verdict: Verdict;
  star: number;
  onVerdict: (v: Verdict) => void;
  onStar: (n: number) => void;
  onExport: () => void;
  onRegenerate: () => void;
  onDelete: () => void;
  /** Optional: when provided, the overflow menu offers a quick tag input. */
  onTag?: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tagging, setTagging] = useState(false);
  const [tag, setTag] = useState("");
  const wrap = useRef<HTMLDivElement>(null);

  // Close the overflow menu on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function close() {
    setOpen(false);
    setTagging(false);
    setTag("");
  }

  // Toggle semantics: re-selecting the current verdict/star clears it.
  const toggleVerdict = (v: Verdict) => onVerdict(verdict === v ? "unrated" : v);
  const toggleStar = (n: number) => onStar(star === n ? 0 : n);

  return (
    <div className="viewer-actions">
      <div className="vbar-verdict" role="group" aria-label="Verdict">
        <button
          type="button"
          className={`vbar-btn vbar-reject${verdict === "reject" ? " active" : ""}`}
          aria-pressed={verdict === "reject"}
          title="Reject (X) · click again to clear"
          onClick={() => toggleVerdict("reject")}
        >
          ✕ <span className="vbar-label">Reject</span>
        </button>
        <button
          type="button"
          className={`vbar-btn vbar-pick${verdict === "pick" ? " active" : ""}`}
          aria-pressed={verdict === "pick"}
          title="Pick (P) · click again to clear"
          onClick={() => toggleVerdict("pick")}
        >
          ✓ <span className="vbar-label">Pick</span>
        </button>
      </div>

      <div className="vbar-stars" role="group" aria-label="Rating">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            className={`vbar-star${star >= n ? " on" : ""}`}
            aria-pressed={star >= n}
            title={
              star === n
                ? "Click to clear the rating"
                : `${n} star${n > 1 ? "s" : ""}`
            }
            onClick={() => toggleStar(n)}
          >
            ★
          </button>
        ))}
      </div>

      <div className="vbar-more" ref={wrap}>
        <button
          type="button"
          className={`vbar-btn${open ? " active" : ""}`}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          ⋯ <span className="vbar-label">More</span>
        </button>
        {open && (
          <div className="vbar-menu" role="menu">
            {onTag &&
              (tagging ? (
                <form
                  className="vbar-menu-tag"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (tag.trim()) {
                      onTag(tag.trim());
                      close();
                    }
                  }}
                >
                  <input
                    autoFocus
                    className="input"
                    placeholder="tag name…"
                    value={tag}
                    onChange={(e) => setTag(e.target.value)}
                  />
                </form>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  className="vbar-menu-item"
                  onClick={() => setTagging(true)}
                >
                  <span className="vbar-menu-ic">#</span> Tag…
                </button>
              ))}
            <button
              type="button"
              role="menuitem"
              className="vbar-menu-item"
              onClick={() => {
                onExport();
                close();
              }}
            >
              <span className="vbar-menu-ic">⤓</span> Export
            </button>
            <button
              type="button"
              role="menuitem"
              className="vbar-menu-item"
              onClick={() => {
                onRegenerate();
                close();
              }}
            >
              <span className="vbar-menu-ic">↻</span> Regenerate derivatives
            </button>
            <div className="vbar-menu-sep" />
            <button
              type="button"
              role="menuitem"
              className="vbar-menu-item danger"
              onClick={() => {
                onDelete();
                close();
              }}
            >
              <span className="vbar-menu-ic">🗑</span> Delete
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
