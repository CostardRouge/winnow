import type { Metadata } from "next";
import CaptureDaysSection from "./CaptureDaysSection";

export const metadata: Metadata = { title: "Dates & places · Pipeline" };

// Settings › Pipeline › Dates & places — when and where each frame was taken,
// beyond what its own file says (migration 0046, lib/captureDays.ts).
export default function CaptureRoute() {
  return <CaptureDaysSection />;
}
