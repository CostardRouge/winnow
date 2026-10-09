import type { Metadata } from "next";
import CaptureFlow from "./CaptureFlow";

export const metadata: Metadata = { title: "Dates & places · Pipeline" };

// Settings › Pipeline › Dates & places — when and where each frame was taken,
// beyond what its own file says: the local capture day (migration 0046,
// lib/captureDays.ts) and imported GPS tracks (0047, lib/trackImport.ts), as
// two numbered steps — a track import skips the times step 1 has not read.
export default function CaptureRoute() {
  return <CaptureFlow />;
}
