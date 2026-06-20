import type { ReactNode } from "react";

// A small abstraction for a "section" made of interchangeable views, each with
// its own body and (optionally) its own toolbar controls — its "view modifier".
//
// The segmented control lists every view; the active view may contribute extra
// controls that ride the same toolbar row (e.g. Sessions → list/card toggle,
// Grid → the Select button). Views flagged `usesGalleryData` share the gallery's
// filters/items/facets, so the host can fetch lazily only when one is active.
//
// This keeps the host (GalleryShell) free of hard-coded per-view conditions:
// it just iterates the registry and renders `active.controls` / `active.render()`.

export type SectionView = {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Toolbar controls shown next to the segmented control when this view is
   *  active — the view's own "modifier". */
  controls?: ReactNode;
  /** The view's body. */
  render: () => ReactNode;
  /** Marks views backed by the shared gallery dataset (Grid, Map). */
  usesGalleryData?: boolean;
};

export function ViewSegments({
  views,
  active,
  onSelect,
}: {
  views: SectionView[];
  active: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="view-toggle" role="group" aria-label="View">
      {views.map((v) => (
        <button
          key={v.id}
          className={`view-btn${active === v.id ? " active" : ""}`}
          onClick={() => onSelect(v.id)}
          aria-pressed={active === v.id}
        >
          {v.icon}
          {v.label}
        </button>
      ))}
    </div>
  );
}
