"use client";

import GalleryShell from "../../gallery/GalleryShell";

// /library/gallery — the finals gallery, now a Library tab. A read-only view of
// finalized exports only (scope="final"): incoming / inbox / export-staging
// assets are excluded. The Library layout supplies the topbar + tabs, so this
// page is just the shell (mirrors how Incoming embeds the same GalleryShell).
export default function LibraryGalleryPage() {
  return <GalleryShell scope="final" />;
}
