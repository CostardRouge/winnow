"use client";

import { Suspense, useCallback, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import GalleryShell from "../../gallery/GalleryShell";
import { decodeFilters, encodeFilters } from "../../gallery/filterParams";
import type { Filters } from "../../gallery/FilterPanel";

// /library/gallery — the finals gallery, now a Library tab. A read-only view of
// finalized exports only (scope="final"): incoming / inbox / export-staging
// assets are excluded. The Library layout supplies the topbar + tabs, so this
// page is just the shell (mirrors how Incoming embeds the same GalleryShell).
//
// Filters live in the query string, exactly as they do on Incoming: the tab is
// then shareable, reload-safe, and — the reason this plumbing exists — a deep
// link like `?device=…&lens=…` actually lands filtered. The /gear shelf points
// straight here for gear whose frames have already been finalized.
function LibraryGallery() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Seeded from the URL once; GalleryShell owns the filters thereafter and
  // notifies us so we can mirror them back.
  const [initialFilters] = useState<Filters>(() =>
    decodeFilters(new URLSearchParams(searchParams.toString())),
  );

  // Replace, not push: Back steps out of the tab rather than through each
  // filter edit (same rule as IncomingTab).
  const onFiltersChange = useCallback(
    (f: Filters) => {
      const qs = encodeFilters(f).toString();
      router.replace(`/library/gallery${qs ? `?${qs}` : ""}`, { scroll: false });
    },
    [router],
  );

  return (
    <GalleryShell
      scope="final"
      initialFilters={initialFilters}
      onFiltersChange={onFiltersChange}
    />
  );
}

export default function LibraryGalleryPage() {
  // Suspense: the page reads useSearchParams, which opts the route out of
  // static prerendering unless the read sits behind a boundary.
  return (
    <Suspense>
      <LibraryGallery />
    </Suspense>
  );
}
