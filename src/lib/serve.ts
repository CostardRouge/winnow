// Serves a derivative (thumb/proxy) from its storage key.
// Disk → we return the bytes (with Range request handling, indispensable
// for playback/seek of video proxies). S3/MinIO → redirect to a signed
// URL (the browser then does the Range directly against S3).
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
    return NextResponse.json({ error: "Derivative not available" }, { status: 404 });
  }

  const storage = await getStorage();
  const signed = await storage.signedUrl(row.key);
  if (signed) return NextResponse.redirect(signed);

  const bytes = await storage.get(row.key);
  if (!bytes) {
    return NextResponse.json({ error: "Derivative not found" }, { status: 404 });
  }

  const type = contentType(row.key);
  const total = bytes.length;
  const base: Record<string, string> = {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=31536000, immutable",
  };

  // Partial request (video player): we respond 206 with the requested slice.
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
