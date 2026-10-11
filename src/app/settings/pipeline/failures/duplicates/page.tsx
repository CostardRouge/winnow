import { redirect } from "next/navigation";

// The duplicate triage moved to Library › Duplicates (2026-10-11): a duplicate
// is a cleanup with a measurable win, not a pipeline failure. Old links and
// bookmarks land on the new page.
export default function DuplicatesMovedPage() {
  redirect("/library/duplicates");
}
