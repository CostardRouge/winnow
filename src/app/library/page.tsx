import { redirect } from "next/navigation";

// /library → the default tab + view (Incoming · Sessions).
export default function LibraryIndex() {
  redirect("/library/incoming/sessions");
}
