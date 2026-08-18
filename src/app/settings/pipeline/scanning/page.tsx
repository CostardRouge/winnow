import type { Metadata } from "next";
import Scanning from "./Scanning";

export const metadata: Metadata = { title: "Scanning · Pipeline" };

export default function ScanningRoute() {
  return <Scanning />;
}
