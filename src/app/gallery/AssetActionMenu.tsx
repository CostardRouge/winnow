"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

// Reusable right-click action menu for a single asset, shared by the gallery
// grid and the session grid. The host handles each emitted action (it owns the
// optimistic state + the network call), so this stays purely presentational.

export type AssetMenuAction =
  | { kind: "verdict"; verdict: "pick" | "reject" | "unrated" }
  | { kind: "star"; star: number }
  | { kind: "tag"; name: string }
  | { kind: "export" }
  | { kind: "download" }
  | { kind: "regenerate" }
  | { kind: "geocode" }
  | { kind: "delete" };

export default function AssetActionMenu({
  x,
  y,
  label,
  onAction,
  onClose,
}: {
  x: number;
  y: number;
  label?: string;
  onAction: (a: AssetMenuAction) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [tagging, setTagging] = useState(false);
  const [tag, setTag] = useState("");
  const [pos, setPos] = useState({ x, y });

  // Clamp into the viewport once the menu has been measured.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)),
    });
  }, [x, y, tagging]);

  // Dismiss on outside click, Escape, scroll or resize.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const fire = (a: AssetMenuAction) => {
    onAction(a);
    onClose();
  };

  return (
    <div
      ref={ref}
      className="ctx-menu"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {label && <div className="ctx-label">{label}</div>}

      <button className="ctx-item" onClick={() => fire({ kind: "verdict", verdict: "pick" })}>
        <span className="ctx-ic" style={{ color: "var(--color-pick)" }}>✓</span> Pick
      </button>
      <button className="ctx-item" onClick={() => fire({ kind: "verdict", verdict: "reject" })}>
        <span className="ctx-ic" style={{ color: "var(--color-reject)" }}>✕</span> Reject
      </button>
      <button className="ctx-item" onClick={() => fire({ kind: "verdict", verdict: "unrated" })}>
        <span className="ctx-ic">↺</span> Clear verdict
      </button>

      <div className="ctx-stars" role="group" aria-label="Rate">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            className="ctx-star"
            title={`${n} star${n > 1 ? "s" : ""}`}
            onClick={() => fire({ kind: "star", star: n })}
          >
            ★
          </button>
        ))}
        <button
          className="ctx-star ctx-star-off"
          title="Clear stars"
          onClick={() => fire({ kind: "star", star: 0 })}
        >
          ✕
        </button>
      </div>

      <div className="ctx-sep" />

      {tagging ? (
        <form
          className="ctx-tag"
          onSubmit={(e) => {
            e.preventDefault();
            if (tag.trim()) fire({ kind: "tag", name: tag });
          }}
        >
          <input
            autoFocus
            className="input"
            placeholder="tag name…"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            style={{ width: "100%", padding: "4px 8px" }}
          />
        </form>
      ) : (
        <button className="ctx-item" onClick={() => setTagging(true)}>
          <span className="ctx-ic">#</span> Tag…
        </button>
      )}

      <button className="ctx-item" onClick={() => fire({ kind: "export" })}>
        <span className="ctx-ic">⤓</span> Export
      </button>

      <button className="ctx-item" onClick={() => fire({ kind: "download" })}>
        <span className="ctx-ic">⇩</span> Download original
      </button>

      <button className="ctx-item" onClick={() => fire({ kind: "regenerate" })}>
        <span className="ctx-ic">↻</span> Regenerate derivatives
      </button>

      <button className="ctx-item" onClick={() => fire({ kind: "geocode" })}>
        <span className="ctx-ic">📍</span> Resolve location
      </button>

      <div className="ctx-sep" />

      <button className="ctx-item ctx-danger" onClick={() => fire({ kind: "delete" })}>
        <span className="ctx-ic">🗑</span> Delete
      </button>
    </div>
  );
}
