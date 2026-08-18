import type { Metadata } from "next";
import { one } from "@/lib/db";
import PersonDetail from "./PersonDetail";

// Tab title carries the person's name ("Marie · People — Winnow"); an unnamed
// stack falls back to the same "Unnamed" the header shows. Best-effort: an
// unknown id or a DB hiccup falls back to the section name.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const personId = Number.parseInt(id, 10);
  if (!Number.isFinite(personId)) return { title: "People" };
  try {
    const person = await one<{ name: string | null }>(
      "SELECT name FROM people WHERE id = $1",
      [personId],
    );
    return { title: person ? `${person.name ?? "Unnamed"} · People` : "People" };
  } catch {
    return { title: "People" };
  }
}

// One person: their media grid (the gallery's own tiles + viewer), the rename
// field, the cover-face picker and the merge action. The URL carries the person
// id, so a stack is linkable from anywhere (the /people shelf, a facet chip).
export default async function PersonPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <PersonDetail personId={Number.parseInt(id, 10)} />;
}
