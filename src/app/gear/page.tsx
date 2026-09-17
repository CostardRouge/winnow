import type { Metadata } from "next";
import GearPanel from "./GearPanel";
import { requireFeature } from "@/lib/featureGate";

export const metadata: Metadata = { title: "Gear" };

// Dedicated Gear page: the shelf of every camera body and lens the library was
// shot with, counted from the EXIF and read eight ways (cf. GearPanel). The
// inverse of the gallery's device/lens filter chips — instead of "narrow the
// grid by camera", it answers "what have I shot with, and how much" at a
// glance, then links each piece of gear back to its frames.
export default async function GearPage() {
  await requireFeature("gear");

  return (
    <div className="app-shell">
      {/* The panel renders the header too, not just the toolbar band and the
          padded body: the header's tabs are the library-source picker, whose
          state is the panel's. */}
      <GearPanel />
    </div>
  );
}
