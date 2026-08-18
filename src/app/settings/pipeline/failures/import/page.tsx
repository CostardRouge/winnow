import type { Metadata } from "next";
import ImportFailures from "./ImportFailures";

export const metadata: Metadata = { title: "Import failures · Pipeline" };

export default function ImportFailuresRoute() {
  return <ImportFailures />;
}
