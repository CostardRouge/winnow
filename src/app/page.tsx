import { redirect } from "next/navigation";

// The Library dashboard now lives under /library, where each tab/view is a real
// URL segment. The root redirects to its default landing (Incoming · Sessions).
export default function Home() {
  redirect("/library/incoming/sessions");
}
