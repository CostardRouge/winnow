import type { Metadata } from "next";
import PeoplePanel from "./PeoplePanel";

export const metadata: Metadata = { title: "People" };

// Dedicated People page: every person the face clustering found in the library
// (cf. lib/people.ts), one stack per person fronted by a cover face, busiest
// first. The people counterpart of the Gear shelf — instead of "narrow the grid
// by camera", it answers "who is in the library, and how often", then links
// each person to their media.
export default function PeoplePage() {
  return (
    <div className="app-shell">
      <div className="topbar">
        <h1>People</h1>
        <span className="hint max-sm:hidden">who the library sees</span>
      </div>
      <div className="pipeline-body">
        <PeoplePanel />
      </div>
    </div>
  );
}
