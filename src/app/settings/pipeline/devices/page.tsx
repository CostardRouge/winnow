import type { Metadata } from "next";
import DeviceAttribution from "./DeviceAttribution";

export const metadata: Metadata = { title: "Devices · Pipeline" };

export default function DevicesRoute() {
  return <DeviceAttribution />;
}
