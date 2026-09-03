import type { Metadata } from "next";
import { Suspense } from "react";
import TimelinePanel from "./TimelinePanel";

export const metadata: Metadata = { title: "Timeline" };

// The library read as a story. The Calendar answers "what did I shoot that
// day", the Map answers "where"; this page answers "what happened over that
// period" — a chronological stream cut into chapters (a stay in a place) that
// cross session folders, since a session is a directory on disk and never a
// leg of a trip (cf. lib/timeline.ts).
export default function TimelinePage() {
  return (
    // useSearchParams (the deep-linkable mode/granularity/source) needs a
    // Suspense boundary above it or the App Router refuses to prerender.
    <Suspense fallback={null}>
      <TimelinePanel />
    </Suspense>
  );
}
