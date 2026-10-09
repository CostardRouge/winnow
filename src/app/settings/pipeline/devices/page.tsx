import { Suspense } from "react";
import type { Metadata } from "next";
import DeviceAttribution from "./DeviceAttribution";

export const metadata: Metadata = { title: "Devices · Pipeline" };

export default function DevicesRoute() {
  return (
    // The sort and the body facet are read from the URL (useSearchParams),
    // which needs a Suspense boundary above it or the App Router refuses to
    // prerender — same as /heatmap.
    <Suspense fallback={null}>
      <DeviceAttribution />
    </Suspense>
  );
}
