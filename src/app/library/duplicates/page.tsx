import { redirect } from "next/navigation";

// The duplicate triage lived here for a day (2026-10-11) and moved to
// Settings › Pipeline › Duplicates: a Library tab crowded the header every
// photographer opens. Links made meanwhile land on the page's home.
export default function DuplicatesMovedFromLibrary() {
  redirect("/settings/pipeline/duplicates");
}
