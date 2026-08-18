import type { Metadata } from "next";
import ScanFailures from "./ScanFailures";

export const metadata: Metadata = { title: "Scan failures · Pipeline" };

export default function ScanFailuresRoute() {
  return <ScanFailures />;
}
