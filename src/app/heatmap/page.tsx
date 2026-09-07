import type { Metadata } from "next";
import { Suspense } from "react";
import HeatmapPanel from "./HeatmapPanel";
import { requireFeature } from "@/lib/featureGate";

export const metadata: Metadata = { title: "Heatmap" };

// The library read as a distribution. The Calendar answers "what did I shoot
// that day" one month at a time and the Map plots a marker per asset; neither
// can cross the two — "where was I in the summers of 2023–2025", "when did I
// shoot this valley". This page answers when AND where at once, four ways, on
// one measure and one ramp (cf. src/app/heatmap/HeatmapPanel.tsx and
// docs/HEATMAP.md for the design and what each reading gives up).
//
// Behind a feature flag, off by default: it is a step-back view, and the rail
// is the scarcest surface in the app.
export default async function HeatmapPage() {
  await requireFeature("heatmap");

  return (
    // useSearchParams (the deep-linkable view/measure/span) needs a Suspense
    // boundary above it or the App Router refuses to prerender.
    <Suspense fallback={null}>
      <HeatmapPanel />
    </Suspense>
  );
}
