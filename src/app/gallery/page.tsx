import { redirect } from "next/navigation";

// The finals gallery moved into the Library as a tab (/library/gallery) and was
// dropped from the nav rail. This route stays as a redirect so old links,
// bookmarks and PWA shortcuts still land in the right place. The gallery's
// shared components (GalleryShell, FilterPanel, …) continue to live in this
// folder and are imported from there by the Library tabs.
export default function GalleryRedirect() {
  redirect("/library/gallery");
}
