import type { Metadata } from "next";
import MlFailures from "./MlFailures";

export const metadata: Metadata = { title: "ML failures · Pipeline" };

export default function MlFailuresRoute() {
  return <MlFailures />;
}
