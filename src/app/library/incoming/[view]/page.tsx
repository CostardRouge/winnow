"use client";

import { notFound, useParams } from "next/navigation";
import IncomingTab from "../../../IncomingTab";

// One page for all three Incoming views — the `[view]` segment selects which.
// Navigating between them re-renders this page in place (same dynamic segment),
// so IncomingTab/GalleryShell stay mounted and the loaded grid + filter state
// carry across the switch.
const VIEWS = ["sessions", "grid", "map"];

export default function IncomingViewPage() {
  const { view } = useParams<{ view: string }>();
  if (!VIEWS.includes(view)) notFound();
  return <IncomingTab view={view} />;
}
