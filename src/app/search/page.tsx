import type { Metadata } from "next";
import SearchPage from "./SearchPage";
import { requireFeature } from "@/lib/featureGate";

export const metadata: Metadata = { title: "Search" };

// The search experience itself is a client component (query state, keyboard
// flow); this thin server page exists to carry the route metadata.
export default async function SearchRoute() {
  await requireFeature("search");
  return <SearchPage />;
}
