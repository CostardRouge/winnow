import type { Metadata } from "next";
import ExportsTab from "../../ExportsTab";

export const metadata: Metadata = { title: "Exports · Library" };

// /library/exports — browse and act on the RAW-copy export jobs.
export default function ExportsPage() {
  return <ExportsTab />;
}
