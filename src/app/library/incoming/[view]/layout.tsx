import type { Metadata } from "next";

// Metadata-only layout: the page below stays a client component (it must keep
// IncomingTab mounted across view switches — see page.tsx), and a client file
// can't export metadata, so the per-view tab title lives here instead. Keep the
// labels in sync with VIEWS in page.tsx / the Library layout's view switcher.
const VIEW_LABELS: Record<string, string> = {
  sessions: "Sessions",
  grid: "Grid",
  calendar: "Calendar",
  map: "Map",
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ view: string }>;
}): Promise<Metadata> {
  const { view } = await params;
  const label = VIEW_LABELS[view];
  return { title: label ? `${label} · Incoming` : "Incoming" };
}

export default function IncomingViewLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
