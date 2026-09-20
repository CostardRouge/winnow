// GET    /api/apps/:app/files/:sha256 → 200 + the bytes, ETag = the hash,
//                                        `Cache-Control: private, immutable`;
//                                        If-None-Match matching → 304;
//                                        404 when the row is not the caller's.
// PUT    /api/apps/:app/files/:sha256   raw body → 200 { id, bytes, created }.
//                                        Body that does not hash to :sha256 →
//                                        400. Over the per-file cap → 413.
//                                        Over the user's quota → 507.
// DELETE /api/apps/:app/files/:sha256 → 204, whether or not it was there.
//
// The id IS the content hash, so there is no revision dance here and no
// If-Match: the same id can only ever mean the same bytes. That is what makes
// the answer cacheable forever by the client, and a re-upload a no-op.
//
// The cache header is `private`: these bytes are one user's, and a shared
// cache must never hand them to another. An asset's derivative may be public
// on this instance; an app's file never is.
import { NextRequest, NextResponse } from "next/server";
import { identityFromHeaders } from "@/lib/auth";
import { json, badRequest, notFound, serverError } from "@/lib/api";
import { isValidApp } from "@/lib/appDocuments";
import {
  deleteFile,
  getFileRow,
  isValidFileId,
  putFile,
  readFileBytes,
  safeMediaType,
} from "@/lib/appFiles";

// DB-backed route: never pre-rendered/cached at build time.
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ app: string; id: string }> };

async function resolve(req: NextRequest, params: Params["params"]) {
  const me = identityFromHeaders(req.headers);
  if (!me) return { error: json({ error: "authentication required" }, 401) };
  const { app, id } = await params;
  if (!isValidApp(app)) return { error: badRequest("bad app") };
  // The id is a SHA-256 in hex and nothing else: it is the storage key's last
  // segment, so anything looser would be a path trick.
  if (!isValidFileId(id)) return { error: badRequest("bad id (expected a hex sha256)") };
  return { me, app, id };
}

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const r = await resolve(req, params);
    if ("error" in r) return r.error;
    const row = await getFileRow(r.me.id, r.app, r.id);
    if (!row) return notFound();

    // The hash IS the validator; a matching If-None-Match can always be
    // answered without touching storage.
    const etag = `"${row.id}"`;
    const inm = req.headers.get("if-none-match");
    if (inm && inm.replace(/^W\//i, "").split(",").some((v) => v.trim() === etag)) {
      return new NextResponse(null, { status: 304, headers: { ETag: etag } });
    }

    const bytes = await readFileBytes(row);
    // The row promises bytes the storage no longer holds (an operator wiped
    // the volume, a crash between the two writes). Say "gone" rather than
    // serving an empty body that a client would decode as a broken file.
    if (!bytes) return notFound();

    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": row.media_type,
        "Content-Length": String(bytes.byteLength),
        ETag: etag,
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  } catch (err) {
    return serverError(err);
  }
}

export async function PUT(req: NextRequest, { params }: Params) {
  try {
    const r = await resolve(req, params);
    if ("error" in r) return r.error;

    const body = Buffer.from(await req.arrayBuffer());
    if (!body.byteLength) return badRequest("empty body");
    const outcome = await putFile(
      r.me.id,
      r.app,
      r.id,
      body,
      safeMediaType(req.headers.get("content-type")),
    );

    if (outcome.status === "mismatch") {
      return badRequest("the body does not hash to that id", { sha256: outcome.actual });
    }
    if (outcome.status === "too-large") {
      return json({ error: "file too large", limit: outcome.limit }, 413);
    }
    if (outcome.status === "quota") {
      // 507 Insufficient Storage: the request is fine, the account is full.
      return json({ error: "storage quota reached", used: outcome.used, limit: outcome.limit }, 507);
    }
    return json({ id: r.id, bytes: outcome.bytes, created: outcome.created });
  } catch (err) {
    return serverError(err);
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  try {
    const r = await resolve(req, params);
    if ("error" in r) return r.error;
    // Absent is not an error to a caller who asked for it gone.
    await deleteFile(r.me.id, r.app, r.id);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return serverError(err);
  }
}
