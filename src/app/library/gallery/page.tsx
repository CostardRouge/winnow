import type { Metadata } from "next";
import GalleryTab from "./GalleryTab";

export const metadata: Metadata = { title: "Gallery · Library" };

export default function LibraryGalleryRoute() {
  return <GalleryTab />;
}
