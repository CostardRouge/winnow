import { redirect } from "next/navigation";

// "Analyzed" used to be its own page (derivative_status=ready, processed order).
// That is now just one status of the unified Media browser — the two listings
// were near-identical in practice (nearly every media ends up Ready), so a
// separate tab wasn't earning its place. The route is kept as a redirect so old
// bookmarks and the overview counter still land on the ready-derivatives view.
export default function AnalyzedPage() {
  redirect("/pipeline/media?status=ready&sort=processed");
}
