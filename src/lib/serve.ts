// Sert un dérivé (thumb/proxy) à partir de sa clé de stockage.
// Disque → on renvoie les octets. S3/MinIO → on redirige vers une URL signée.
import { NextResponse } from "next/server";
import { one } from "@/lib/db";
import { getStorage } from "@/lib/storage";

export async function serveDerivative(
  assetId: number,
  which: "thumb" | "proxy",
): Promise<NextResponse> {
  const col = which === "thumb" ? "thumb_key" : "proxy_key";
  const row = await one<{ key: string | null }>(
    `SELECT ${col} AS key FROM assets WHERE id = $1`,
    [assetId],
  );
  if (!row?.key) {
    return NextResponse.json({ error: "Dérivé non disponible" }, { status: 404 });
  }

  const storage = await getStorage();
  const signed = await storage.signedUrl(row.key);
  if (signed) return NextResponse.redirect(signed);

  const bytes = await storage.get(row.key);
  if (!bytes) {
    return NextResponse.json({ error: "Dérivé introuvable" }, { status: 404 });
  }
  return new NextResponse(bytes as unknown as BodyInit, {
    headers: {
      "Content-Type": "image/webp",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
