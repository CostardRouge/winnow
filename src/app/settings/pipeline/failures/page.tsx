import { redirect } from "next/navigation";

// /settings/pipeline/failures has no pane of its own — the family tab bar's
// first entry is the content (same pattern as /settings → /settings/pipeline).
// The tab badges carry the live counts, so a family with failures is visible
// at a glance from anywhere in the section.
export default function FailuresIndexPage() {
  redirect("/settings/pipeline/failures/analyze");
}
