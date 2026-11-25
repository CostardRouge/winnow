import type { Metadata } from "next";
import { Suspense } from "react";
import { one } from "@/lib/db";
import SessionGrid from "./SessionGrid";

type Params = { params: Promise<{ id: string }> };

// Tab title carries the session name ("2024-08 Corse · Sessions — Winnow").
// Best-effort: an unknown id or a DB hiccup falls back to the section name —
// the page itself surfaces the error.
export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params;
  const sessionId = Number.parseInt(id, 10);
  if (!Number.isFinite(sessionId)) return { title: "Sessions" };
  try {
    const session = await one<{ name: string }>(
      "SELECT name FROM sessions WHERE id = $1",
      [sessionId],
    );
    return { title: session ? `${session.name} · Sessions` : "Sessions" };
  } catch {
    return { title: "Sessions" };
  }
}

export default function SessionRoute({ params }: Params) {
  // Suspense: the grid reads useSearchParams (its filters live in the URL),
  // which a route may only do behind a boundary.
  return (
    <Suspense>
      <SessionGrid params={params} />
    </Suspense>
  );
}
