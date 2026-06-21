import { redirect } from "next/navigation";

// /library/incoming → the default Incoming view (Sessions).
export default function IncomingIndex() {
  redirect("/library/incoming/sessions");
}
