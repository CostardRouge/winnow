// Sert un dérivé (thumb/proxy) à partir de sa clé de stockage.
// Disque → on renvoie les octets (avec gestion des requêtes Range, indispensable
// pour la lecture/seek des proxies vidéo). S3/MinIO → redirection vers une URL
// signée (le navigateur fait alors le Range directement contre S3).
import { NextResponse } from "next/server";
import { one } from "@/lib/db";
import { getStorage } from "@/lib/storage";

function contentType(key: string): string {
  if (key.endsWith(".mp4")) return "video/mp4";
  if (key.endsWith(".webp")) return "image/webp";
  if (key.endsWith(".jpg") || key.endsWith(".jpeg")) return "image/jpeg";
  if (key.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

export async function serveDerivative(
  req: Request,
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

  const type = contentType(row.key);
  const total = bytes.length;
  const base: Record<string, string> = {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=31536000, immutable",
  };

  // Requête partielle (lecteur vidéo) : on répond 206 avec la tranche demandée.
  const range = req.headers.get("range");
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range);
  if (m) {
    let start = m[1] ? Number.parseInt(m[1], 10) : 0;
    let end = m[2] ? Number.parseInt(m[2], 10) : total - 1;
    if (!Number.isFinite(start)) start = 0;
    if (!Number.isFinite(end) || end >= total) end = total - 1;
    if (start > end || start >= total) {
      return new NextResponse(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${total}` },
      });
    }
    const chunk = bytes.subarray(start, end + 1);
    return new NextResponse(chunk as unknown as BodyInit, {
      status: 206,
      headers: {
        ...base,
        "Content-Range": `bytes ${start}-${end}/${total}`,
        "Content-Length": String(chunk.length),
      },
    });
  }

  return new NextResponse(bytes as unknown as BodyInit, {
    headers: { ...base, "Content-Length": String(total) },
  });
}
