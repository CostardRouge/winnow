import type { Metadata } from "next";
import SearchIndex from "./SearchIndex";

export const metadata: Metadata = { title: "Search index · Pipeline" };

export default function SearchIndexRoute() {
  return <SearchIndex />;
}
