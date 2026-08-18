import type { Metadata } from "next";
import DuplicatesFailures from "./DuplicatesFailures";

export const metadata: Metadata = { title: "Deduplication · Pipeline" };

export default function DuplicatesFailuresRoute() {
  return <DuplicatesFailures />;
}
