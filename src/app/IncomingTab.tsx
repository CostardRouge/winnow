"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import GalleryShell from "./gallery/GalleryShell";
import { decodeFilters, encodeFilters } from "./gallery/filterParams";
import type { Filters } from "./gallery/FilterPanel";
import SessionsPane, { type Layout, type SortDir } from "./SessionsPane";
import type { SectionView } from "./gallery/ViewSwitch";
import { Icons } from "./ui";

// Incoming = everything to cull. It is one gallery section with three views:
//   Sessions (default) · Grid · Map
// The active view is a real route segment (/library/incoming/<view>) and the
// filters live in the query string, so any state is shareable and reload-safe.
// The Sessions view is injected into the shared GalleryShell as an extra view,
// carrying its own toolbar modifiers (the list/card layout toggle and a newest/
// oldest sort toggle) and sharing the host's Filters/Browse panel. Grid and Map
// are GalleryShell's built-in, filter-driven views.

const LAYOUT_KEY = "winnow.sessions.layout";

export default function IncomingTab({ view }: { view: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [layout, setLayout] = useState<Layout>("list");
  // Newest-first by default; the toggle flips to oldest-first.
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // Filters are seeded from the URL once (deep links / reloads restore them);
  // GalleryShell owns them thereafter and notifies us to mirror them back.
  const [initialFilters] = useState<Filters>(() =>
    decodeFilters(new URLSearchParams(searchParams.toString())),
  );

  // The `view` prop trails the router by a tick (navigation is async), so when
  // an action switches view *and* changes filters in the same commit — e.g. the
  // map's "Grid" zone action, which applies a bbox then jumps to the grid — the
  // filter-mirror below would otherwise replace the URL using the stale, current
  // view and cancel the view switch (the classic "click Grid twice" bug). Latch
  // the view we're navigating to so the filter mirror targets the right segment.
  const pendingViewRef = useRef<string | null>(null);
  useEffect(() => {
    pendingViewRef.current = null;
  }, [view]);

  // Switch view by navigating — carry the current filters across the hop.
  const onSelectView = useCallback(
    (id: string) => {
      pendingViewRef.current = id;
      const qs = searchParams.toString();
      router.push(`/library/incoming/${id}${qs ? `?${qs}` : ""}`);
    },
    [router, searchParams],
  );

  // Reflect filter changes in the URL without growing history (replace, no
  // scroll jump) so Back still steps between views rather than filter edits.
  const onFiltersChange = useCallback(
    (f: Filters) => {
      const target = pendingViewRef.current ?? view;
      const qs = encodeFilters(f).toString();
      router.replace(`/library/incoming/${target}${qs ? `?${qs}` : ""}`, {
        scroll: false,
      });
    },
    [router, view],
  );

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
      view={view}
      onSelectView={onSelectView}
      initialFilters={initialFilters}
      onFiltersChange={onFiltersChange}
    />
  );
}
