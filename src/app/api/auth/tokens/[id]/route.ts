// DELETE /api/auth/tokens/:id → revoke one app token (admin-only, like the
// rest of /api/auth/tokens). The row goes and so does its cache entry, so the
// next request carrying it is a 401 — the app then asks for a new token.
import { NextRequest } from "next/server";
import { revokeAccessToken } from "@/lib/auth";
import { json, badRequest, notFound, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const id = Number.parseInt((await params).id, 10);
    if (!Number.isFinite(id)) return badRequest("Invalid id");
    if (!(await revokeAccessToken(id))) return notFound("No such token");
    return json({ ok: true });
  } catch (err) {
    return serverError(err);
  }
}
