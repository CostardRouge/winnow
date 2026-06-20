"use client";

import GalleryShell from "./GalleryShell";

// The finals gallery: a read-only view of finalized exports only (kind=finals).
// Incoming / inbox / export-staging assets are excluded by the `final` scope —
// this is the canonical place to browse finished work (it replaced the former
// "Final" tab on the Library page).
export default function GalleryPage() {
  return (
    <div className="gallery-layout">
      <div className="topbar">
        <h1>Gallery</h1>
        <span className="hint">finals only</span>
      </div>
      <GalleryShell scope="final" />
    </div>
  );
}
