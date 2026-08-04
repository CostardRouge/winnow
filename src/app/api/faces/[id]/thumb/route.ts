// GET /api/faces/:id/thumb → a square WebP crop of one detected face, cut from
// the asset's EXISTING derivative (photo proxy / video poster) — the avatar the
// People page and the cover picker draw. Cropped on the fly with sharp: face
// crops are small (256px), requested once per visible card, and the browser
// caches them hard (immutable + ETag), so pre-rendering them into storage would
// buy nothing but another object class to garbage-collect.
//
// The stored bounding box is in pixels of the ANALYZED image, whose dimensions
// ride alongside (img_width/img_height, cf. migration 0021) — so the box scales
// onto the derivative even if that derivative was regenerated at another size
// since the analysis. The box is grown ~80% per side before cropping (a tight
// detector box makes a claustrophobic avatar) and clamped to the image.
import { NextResponse } from "next/server";
import sharp from "sharp";
import { one } from "@/lib/db";
import { serverError } from "@/lib/api";
import { getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";

const SIZE = 256; // output edge, px
const MARGIN = 0.8; // growth per side, as a fraction of the box's larger edge

const CACHE_CONTROL = "public, max-age=31536000, immutable";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const faceId = Number.parseInt(id, 10);
    if (!Number.isFinite(faceId)) {
      return NextResponse.json({ error: "Invalid face id" }, { status: 400 });
    }

    const row = await one<{
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      img_width: number | null;
      img_height: number | null;
      media_type: "photo" | "video";
      thumb_key: string | null;
      proxy_key: string | null;
      updated_at: string | null;
    }>(
      `SELECT f.x1, f.y1, f.x2, f.y2, f.img_width, f.img_height,
              a.media_type, a.thumb_key, a.proxy_key, a.updated_at
         FROM asset_faces f
         JOIN assets a ON a.id = f.asset_id
        WHERE f.id = $1 AND a.deleted_at IS NULL`,
      [faceId],
    );
    if (!row) {
      return NextResponse.json({ error: "Face not found" }, { status: 404 });
    }

    // Same image choice as the analysis itself (cf. lib/ml.runMlJob): the photo
    // proxy, or the poster for a video — the box was measured on that family.
    const key =
      row.media_type === "video"
        ? row.thumb_key
        : (row.proxy_key ?? row.thumb_key);
    if (!key) {
      return NextResponse.json({ error: "Derivative not available" }, { status: 404 });
    }

    // Face rows are immutable (re-analysis re-mints them under new ids) and the
    // asset's updated_at identifies the derivative bytes (cf. lib/serve.ts) —
    // together they version the crop. Answer 304 before touching storage.
    const epoch = row.updated_at ? Date.parse(row.updated_at) : Number.NaN;
    const etag = Number.isFinite(epoch) ? `W/"face-${faceId}-${epoch}"` : null;
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
    const image = await storage.get(key);
    if (!image) {
      return NextResponse.json({ error: "Derivative not found" }, { status: 404 });
    }

    const pipeline = sharp(image, { failOn: "none" });
    const meta = await pipeline.metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (!width || !height) {
      return NextResponse.json({ error: "Unreadable derivative" }, { status: 500 });
    }

    // Project the box onto THIS rendition, grow it, clamp it. A missing
    // analyzed-dimension pair means the analysis predates 0021's dims columns —
    // assume the derivative is the analyzed image (scale 1).
    const sx = row.img_width ? width / row.img_width : 1;
    const sy = row.img_height ? height / row.img_height : 1;
    const bx1 = row.x1 * sx;
    const by1 = row.y1 * sy;
    const bx2 = row.x2 * sx;
    const by2 = row.y2 * sy;
    const edge = Math.max(bx2 - bx1, by2 - by1);
    if (edge <= 0) {
      return NextResponse.json({ error: "Degenerate face box" }, { status: 500 });
    }
    const grow = edge * MARGIN;
    const left = Math.max(0, Math.round(bx1 - grow));
    const top = Math.max(0, Math.round(by1 - grow));
    const right = Math.min(width, Math.round(bx2 + grow));
    const bottom = Math.min(height, Math.round(by2 + grow));

    const out = await pipeline
      .extract({
        left,
        top,
        width: Math.max(1, right - left),
        height: Math.max(1, bottom - top),
      })
      .resize(SIZE, SIZE, { fit: "cover" })
      .webp({ quality: 82 })
      .toBuffer();

    return new NextResponse(new Uint8Array(out), {
      headers: {
        "Content-Type": "image/webp",
        "Content-Length": String(out.length),
        "Cache-Control": CACHE_CONTROL,
        ...(etag ? { ETag: etag } : {}),
      },
    });
  } catch (err) {
    return serverError(err);
  }
}
