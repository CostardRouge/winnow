import type { Metadata } from "next";
import DuplicatesPanel from "./DuplicatesPanel";

export const metadata: Metadata = { title: "Duplicates · Library" };

// /library/duplicates — clear the copies a scan found twice: the plan by rule,
// the folder pairs, the review queue and your own rule (DuplicatesPanel).
export default function DuplicatesPage() {
  return <DuplicatesPanel />;
}
