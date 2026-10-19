// GET /api/apps/:app/docs ?kind=trip → { docs: [{ id, kind, version,
//                                       updated_at, etag, doc }] }
//                         &fields=summary → each row carries `summary` in
//                                       place of `doc` where it has one
//
// The caller's OWN documents under one app namespace, newest first. Without
// `fields`, bodies included, as always. With `fields=summary` (migration
// 0056), the summary the client sent with the body stands in for it, so a
// gallery of Develop rolls — tens of MB each — lists in a few KB; a row with
// no summary still carries its body, so an older document never lists as an
// empty card. Winnow never reads `doc` nor `summary`; see lib/appDocuments.ts
// for the ownership and revision rules, migration 0041 for the table.
//
// Self-service (lib/authz.ts): any signed-in role owns its documents, the
// same way it owns its password — a viewer keeps trips too.
import { NextRequest } from "next/server";
import { identityFromHeaders } from "@/lib/auth";
import { json, badRequest, serverError } from "@/lib/api";
import { isDocKind, isValidApp, listDocumentSummaries, listDocuments } from "@/lib/appDocuments";

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
    const fields = req.nextUrl.searchParams.get("fields");
    if (fields !== null && fields !== "summary") return badRequest("unknown fields");
    const docs =
      fields === "summary"
        ? await listDocumentSummaries(me.id, app, kind)
        : await listDocuments(me.id, app, kind);
    return json({ docs });
  } catch (err) {
    return serverError(err);
  }
}
