// GET /api/apps/:app/docs ?kind=trip → { docs: [{ id, kind, version,
//                                       updated_at, etag, doc }] }
//
// The caller's OWN documents under one app namespace, newest first, bodies
// included — a trip is tens of KB and a person keeps a handful, so a summary
// column would buy nothing. Winnow never reads `doc`; see lib/appDocuments.ts
// for the ownership and revision rules, migration 0041 for the table.
//
// Self-service (lib/authz.ts): any signed-in role owns its documents, the
// same way it owns its password — a viewer keeps trips too.
import { NextRequest } from "next/server";
import { identityFromHeaders } from "@/lib/auth";
import { json, badRequest, serverError } from "@/lib/api";
import { isDocKind, isValidApp, listDocuments } from "@/lib/appDocuments";

// DB-backed route: never pre-rendered/cached at build time.
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ app: string }> },
) {
  try {
    const me = identityFromHeaders(req.headers);
    if (!me) return json({ error: "authentication required" }, 401);
    const { app } = await params;
    if (!isValidApp(app)) return badRequest("bad app");
    const kind = req.nextUrl.searchParams.get("kind");
    if (kind !== null && !isDocKind(kind)) return badRequest("unknown kind");
    const docs = await listDocuments(me.id, app, kind);
    return json({ docs });
  } catch (err) {
    return serverError(err);
  }
}
