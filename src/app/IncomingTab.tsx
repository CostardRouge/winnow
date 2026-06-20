"use client";

import { useEffect, useState } from "react";
import GalleryShell from "./gallery/GalleryShell";
import SessionsPane, { type Layout } from "./SessionsPane";
import type { SectionView } from "./gallery/ViewSwitch";
import { Icons } from "./ui";

// Incoming = everything to cull. It is one gallery section with three views:
//   Sessions (default) · Grid · Map
// The Sessions view is injected into the shared GalleryShell as an extra view,
// carrying its own toolbar modifier (the list/card layout toggle). Grid and Map
// are GalleryShell's built-in, filter-driven views.

const LAYOUT_KEY = "winnow.sessions.layout";

export default function IncomingTab() {
  const [layout, setLayout] = useState<Layout>("list");

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
    controls: (
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
    ),
    render: () => <SessionsPane layout={layout} />,
  };

  return (
    <GalleryShell
      scope="incoming"
      extraViews={[sessionsView]}
      defaultView="sessions"
    />
  );
}
