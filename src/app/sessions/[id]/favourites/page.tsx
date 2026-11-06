import type { Metadata } from "next";
import { one } from "@/lib/db";
import FavouritesPass from "./FavouritesPass";

type Params = { params: Promise<{ id: string }> };

// DB-backed (the title reads the folder's name): never prerendered.
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params;
  const sessionId = Number.parseInt(id, 10);
  if (!Number.isFinite(sessionId)) return { title: "Favourites pass" };
  try {
    const s = await one<{ name: string }>("SELECT name FROM sessions WHERE id = $1", [sessionId]);
    return { title: s ? `Favourites · ${s.name}` : "Favourites pass" };
  } catch {
    return { title: "Favourites pass" };
  }
}

export default async function FavouritesPassRoute({ params }: Params) {
  const { id } = await params;
  return <FavouritesPass id={id} />;
}
