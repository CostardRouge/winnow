import type { Metadata } from "next";
import AnalyzeFailures from "./AnalyzeFailures";

export const metadata: Metadata = { title: "Analyze failures · Pipeline" };

export default function AnalyzeFailuresRoute() {
  return <AnalyzeFailures />;
}
