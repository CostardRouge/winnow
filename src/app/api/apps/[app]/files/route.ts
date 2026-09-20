// GET /api/apps/:app/files → { files: [{ id, bytes, mediaType, createdAt }],
//                              used, quota, maxBytes }
//
// What this user already stores for this app, ids only — never bytes. It is
// the first call of a client's sync: knowing which hashes are here is what
// turns "push my whole pack" into "push the three looks you are missing".
//
// The rules and the SQL live in lib/appFiles.ts; this file maps them to
// status codes, like the docs routes beside it.
import { NextRequest } from "next/server";
import { identityFromHeaders } from "@/lib/auth";
import { json, badRequest, serverError } from "@/lib/api";
import { isValidApp } from "@/lib/appDocuments";
import { MAX_FILE_BYTES, MAX_USER_BYTES, listFiles, usedBytes } from "@/lib/appFiles";

// DB-backed route: never pre-rendered/cached at build time.
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ app: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const me = identityFromHeaders(req.headers);
    if (!me) return json({ error: "authentication required" }, 401);
    const { app } = await params;
    if (!isValidApp(app)) return badRequest("bad app");

    const [rows, used] = await Promise.all([listFiles(me.id, app), usedBytes(me.id, app)]);
    return json({
      files: rows.map((r) => ({
        id: r.id,
        bytes: Number(r.bytes),
        mediaType: r.media_type,
        createdAt: r.created_at,
      })),
      used,
      quota: MAX_USER_BYTES,
      maxBytes: MAX_FILE_BYTES,
    });
  } catch (err) {
    return serverError(err);
  }
}
