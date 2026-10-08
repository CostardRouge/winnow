import type { Metadata } from "next";
import CaptureDaysSection from "./CaptureDaysSection";
import TrackImportSection from "./TrackImportSection";

export const metadata: Metadata = { title: "Dates & places · Pipeline" };

// Settings › Pipeline › Dates & places — when and where each frame was taken,
// beyond what its own file says: the local capture day (migration 0046,
// lib/captureDays.ts) and imported GPS tracks (0047, lib/trackImport.ts). The
// day repair comes first: a track import skips the times it has not classified.
export default function CaptureRoute() {
  return (
    <div className="pl-stack">
      <CaptureDaysSection />
      <TrackImportSection />
    </div>
  );
}
