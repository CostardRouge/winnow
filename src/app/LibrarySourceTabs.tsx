"use client";

// The Incoming/Gallery/All picker drawn identically on /gear, /people and
// /search — which half of the library a page's counts and links refer to.
// Started as three near-identical hand-rolled toggles (one per page); once a
// third page needed the exact same thing, duplicating it a third time meant
// the pages drifted apart (different markup, different classes) instead of
// staying one control. This is that control, and every page wears the same
// `.tabs`/`.tab` segmented-control classes /gear originated (cf. globals.css
// "Tabs (segmented control)") — the same size and look everywhere.
//
// "All" combines Incoming + Gallery. It reads as a plain sum wherever a page
// shows a number, but there is no single grid that shows both halves in one
// view — Incoming and the Gallery are separate routes (cf. lib/roles.ts).
// Anywhere a card/row must link to ONE grid, `effectiveLibrarySource` picks
// Incoming when the item has anything there, Gallery otherwise — the item's
// own split decides, not a fixed default.
import { useEffect, useState } from "react";

export type LibrarySource = "all" | "incoming" | "gallery";

export const LIBRARY_SOURCES: {
  key: LibrarySource;
  label: string;
  title: string;
}[] = [
  { key: "all", label: "All", title: "Incoming and Gallery combined" },
  { key: "incoming", label: "Incoming", title: "Media still to cull" },
  { key: "gallery", label: "Gallery", title: "Finalized exports" },
];

export function LibrarySourceTabs({
  source,
  onChange,
  ariaLabel = "Which half of the library",
}: {
  source: LibrarySource;
  onChange: (source: LibrarySource) => void;
  ariaLabel?: string;
}) {
  return (
    <div className="tabs" role="group" aria-label={ariaLabel}>
      {LIBRARY_SOURCES.map((s) => (
        <button
          key={s.key}
          className={`tab${source === s.key ? " active" : ""}`}
          onClick={() => onChange(s.key)}
          aria-pressed={source === s.key}
          title={s.title}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}

// Restore / persist the chosen half between visits (client-only, so the first
// render matches the server's) — the boilerplate every page repeated before
// this hook existed. `urlSource`, when given, is a value already decided by
// the current URL (a shared link): it wins on the seeding read and is what
// the initial render uses, so a deep link never flashes the remembered choice
// before snapping to the URL's.
export function useStoredLibrarySource(
  storageKey: string,
  urlSource?: LibrarySource | null,
): [LibrarySource, (source: LibrarySource) => void] {
  const [source, setSource] = useState<LibrarySource>(urlSource ?? "incoming");
  useEffect(() => {
    if (urlSource) return;
    const saved = localStorage.getItem(storageKey);
    if (saved === "all" || saved === "incoming" || saved === "gallery") {
      setSource(saved);
    }
    // Seed once on mount — a later external change to localStorage must not
    // yank the toggle out from under whatever the user just clicked.
  }, []);
  useEffect(() => {
    localStorage.setItem(storageKey, source);
  }, [storageKey, source]);
  return [source, setSource];
}

// Which single grid an "All" card/row should link to: Incoming when the item
// has anything there, Gallery otherwise. Not just "Incoming" — an item with
// nothing incoming (already fully exported) would link to an empty grid.
export function effectiveLibrarySource(
  source: LibrarySource,
  incomingCount: number,
): "incoming" | "gallery" {
  if (source !== "all") return source;
  return incomingCount > 0 ? "incoming" : "gallery";
}
