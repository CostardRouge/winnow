"use client";

import { useEffect, useState } from "react";
import GalleryShell from "./gallery/GalleryShell";
import SessionsPane, { type Layout, type SortDir } from "./SessionsPane";
import type { SectionView } from "./gallery/ViewSwitch";
import { Icons } from "./ui";

// Incoming = everything to cull. It is one gallery section with three views:
//   Sessions (default) · Grid · Map
// The Sessions view is injected into the shared GalleryShell as an extra view,
// carrying its own toolbar modifiers (the list/card layout toggle and a newest/
// oldest sort toggle) and sharing the host's Filters/Browse panel. Grid and Map
// are GalleryShell's built-in, filter-driven views.

const LAYOUT_KEY = "winnow.sessions.layout";

export default function IncomingTab() {
  const [layout, setLayout] = useState<Layout>("list");
  // Newest-first by default; the toggle flips to oldest-first.
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // Restore / persist the layout choice (client-only to avoid SSR mismatch).
  useEffect(() => {
    const saved = localStorage.getItem(LAYOUT_KEY);
    if (saved === "list" || saved === "card") setLayout(saved);
  }, []);
  useEffect(() => {
    localStorage.setItem(LAYOUT_KEY, layout);
  }, [layout]);

  const sessionsView: SectionView = {
    id: "sessions",
    label: "Sessions",
    usesFilters: true,
    controls: (
      <>
        <button
          className="btn"
          onClick={() => setSortDir((d) => (d === "desc" ? "asc" : "desc"))}
          aria-label={
            sortDir === "desc" ? "Newest first (tap for oldest)" : "Oldest first (tap for newest)"
          }
          title={sortDir === "desc" ? "Newest first" : "Oldest first"}
        >
          {sortDir === "desc" ? Icons.arrowDown : Icons.arrowUp}
          <span className="max-sm:hidden">{sortDir === "desc" ? "Newest" : "Oldest"}</span>
        </button>
        <div className="layout-toggle" role="group" aria-label="Session layout">
          <button
            className={`layout-btn${layout === "list" ? " active" : ""}`}
            onClick={() => setLayout("list")}
            aria-pressed={layout === "list"}
            title="List view"
          >
            {Icons.viewList}
          </button>
          <button
            className={`layout-btn${layout === "card" ? " active" : ""}`}
            onClick={() => setLayout("card")}
            aria-pressed={layout === "card"}
            title="Card view"
          >
            {Icons.viewCard}
          </button>
        </div>
      </>
    ),
    render: (ctx) => (
      <SessionsPane layout={layout} query={ctx.query} sortDir={sortDir} />
    ),
  };

  return (
    <GalleryShell
      scope="incoming"
      extraViews={[sessionsView]}
      defaultView="sessions"
    />
  );
}
