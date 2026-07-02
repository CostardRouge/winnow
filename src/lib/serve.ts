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

const CACHE_CONTROL = "public, max-age=31536000, immutable";

export async function serveDerivative(
  req: Request,
  assetId: number,
  which: "thumb" | "proxy",
): Promise<NextResponse> {
  const col = which === "thumb" ? "thumb_key" : "proxy_key";
  const row = await one<{ key: string | null; updated_at: string | null }>(
    `SELECT ${col} AS key, updated_at FROM assets WHERE id = $1`,
    [assetId],
  );
  if (!row?.key) {
    return NextResponse.json({ error: "Derivative not available" }, { status: 404 });
  }

  // Validator: derivative keys are stable (`thumb/<id>.webp`), but updated_at
  // is bumped whenever a derivative is (re)generated — so it identifies the
  // current bytes. On revalidation (reload, evicted cache) we answer 304 here,
  // before any storage round-trip. Guarded on the parse: a NaN would collapse
  // every asset onto one shared tag and serve stale 304s.
  const epoch = row.updated_at ? Date.parse(row.updated_at) : Number.NaN;
  const etag = Number.isFinite(epoch) ? `W/"${which}-${epoch}"` : null;
  const ifNoneMatch = req.headers.get("if-none-match");
  if (
    etag &&
    ifNoneMatch &&
    ifNoneMatch.split(",").some((t) => t.trim() === etag)
  ) {
    return new NextResponse(null, {
      status: 304,
      headers: { ETag: etag, "Cache-Control": CACHE_CONTROL },
    });
  }

  const storage = await getStorage();
  const signed = await storage.signedUrl(row.key);
  if (signed) {
    // Let the browser reuse the redirect for a while instead of hitting this
    // route (DB query + URL signing) once per tile on every scroll-back. Kept
    // well under the signature's validity (1h) so a cached hop never lands on
    // an expired URL.
    return NextResponse.redirect(signed, {
      headers: { "Cache-Control": "private, max-age=300" },
    });
  }

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
    "Cache-Control": CACHE_CONTROL,
    ...(etag ? { ETag: etag } : {}),
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
