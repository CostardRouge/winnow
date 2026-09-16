import type { Metadata } from "next";
import PeoplePanel from "./PeoplePanel";
import PageHeader from "../PageHeader";
import { requireFeature } from "@/lib/featureGate";

export const metadata: Metadata = { title: "People" };

// Dedicated People page: every person the face clustering found in the library
// (cf. lib/people.ts), one stack per person fronted by a cover face, busiest
// first. The people counterpart of the Gear shelf — instead of "narrow the grid
// by camera", it answers "who is in the library, and how often", then links
// each person to their media.
export default async function PeoplePage() {
  await requireFeature("people");

  return (
    <div className="app-shell">
      <PageHeader title="People" />
      {/* The panel renders its own toolbar band and padded body. */}
      <PeoplePanel />
    </div>
  );
}
