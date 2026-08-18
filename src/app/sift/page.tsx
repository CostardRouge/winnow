import type { Metadata } from "next";
import SiftHub from "./SiftHub";

export const metadata: Metadata = { title: "Sift" };

export default function SiftRoute() {
  return <SiftHub />;
}
