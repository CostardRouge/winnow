import type { Metadata } from "next";
import GpsWriteFailures from "./GpsWriteFailures";

export const metadata: Metadata = { title: "GPS write failures · Pipeline" };

export default function GpsWriteFailuresRoute() {
  return <GpsWriteFailures />;
}
