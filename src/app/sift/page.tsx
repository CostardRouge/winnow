import type { Metadata } from "next";
import SiftHub from "./SiftHub";
import { requireFeature } from "@/lib/featureGate";

export const metadata: Metadata = { title: "Sift" };

export default async function SiftRoute() {
  await requireFeature("sift");
  return <SiftHub />;
}
