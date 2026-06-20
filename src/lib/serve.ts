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

  // Disk backend: stream the requested byte window straight off disk. We only
  // need the file size here (stat), never the whole file in RAM — a seeking
  // video player can fire many Range requests without each one reloading the
  // entire mp4.
  const info = await storage.stat(row.key);
  if (!info) {
    return NextResponse.json({ error: "Derivative not found" }, { status: 404 });
  }

  const type = contentType(row.key);
  const total = info.size;
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
    const stream = await storage.getRange(row.key, start, end);
    if (!stream) {
      return NextResponse.json({ error: "Derivative not found" }, { status: 404 });
    }
    return new NextResponse(stream as unknown as BodyInit, {
      status: 206,
      headers: {
        ...base,
        "Content-Range": `bytes ${start}-${end}/${total}`,
        "Content-Length": String(end - start + 1),
      },
    });
  }

  // Full request: still streamed, never buffered. Guard the empty file so we
  // don't ask for an inverted [0, -1] range.
  if (total === 0) {
    return new NextResponse(null, {
      headers: { ...base, "Content-Length": "0" },
    });
  }
  const stream = await storage.getRange(row.key, 0, total - 1);
  if (!stream) {
    return NextResponse.json({ error: "Derivative not found" }, { status: 404 });
  }
  return new NextResponse(stream as unknown as BodyInit, {
    headers: { ...base, "Content-Length": String(total) },
  });
}
