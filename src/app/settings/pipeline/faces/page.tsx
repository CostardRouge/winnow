import type { Metadata } from "next";
import FacesText from "./FacesText";

export const metadata: Metadata = { title: "Faces & text · Pipeline" };

export default function FacesTextRoute() {
  return <FacesText />;
}
