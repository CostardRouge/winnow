"use client";

import Link from "next/link";
import GalleryShell from "./GalleryShell";

// "All folders" gallery (no scope) — direct/power-user access. Primary navigation
// now goes through the home page tabs; this link no longer appears there but the
// route remains for global exploration and deep-linking.
export default function GalleryPage() {
  return (
    <div className="gallery-layout">
      <div className="topbar">
        <Link href="/" className="btn">←</Link>
        <h1>Gallery</h1>
        <span className="hint">all folders</span>
      </div>
      <GalleryShell />
    </div>
  );
}
