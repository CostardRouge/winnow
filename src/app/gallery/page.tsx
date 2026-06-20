"use client";

import GalleryShell from "./GalleryShell";

// "All folders" gallery (no scope) — direct/power-user access. Primary navigation
// now goes through the home page tabs; this link no longer appears there but the
// route remains for global exploration and deep-linking.
export default function GalleryPage() {
  return (
    <div className="gallery-layout">
      <div className="topbar">
        <h1>Gallery</h1>
        <span className="hint">all folders</span>
      </div>
      <GalleryShell />
    </div>
  );
}
