import type { Metadata } from "next";
import MissingFailures from "./MissingFailures";

export const metadata: Metadata = { title: "Missing files · Pipeline" };

export default function MissingFailuresRoute() {
  return <MissingFailures />;
}
