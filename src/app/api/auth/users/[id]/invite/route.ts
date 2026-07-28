// Per-account invite management (admin-only, like everything under
// /api/auth/users — cf. lib/authz.ts).
//   POST   /api/auth/users/:id/invite → (re-)issue the one-time link. Serves
//          both onboarding ("the link lapsed before they opened it") and the
//          password reset: opening it sets a NEW password and revokes every
//          old session — so the admin still never types anyone's password.
//   DELETE /api/auth/users/:id/invite → revoke a pending link (sent to the
//          wrong person, wrong channel…). Existing sign-ins are untouched.
import { NextRequest } from "next/server";
import { one, q } from "@/lib/db";
import { createInvite, identityFromHeaders, type UserRow } from "@/lib/auth";
import { json, badRequest, notFound, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const id = Number.parseInt((await params).id, 10);
    if (!Number.isFinite(id)) return badRequest("Invalid id");

    const target = await one<UserRow>(
      "SELECT id, username, display_name, role, disabled, created_at, last_login_at FROM users WHERE id = $1",
      [id],
    );
    if (!target) return notFound("No such user");
    // A disabled account's invite would 404 on open anyway (validateInvite
    // checks it) — refuse upfront with a clearer message.
    if (target.disabled)
      return badRequest("Enable the account before sending an invite link");

    const who = identityFromHeaders(req.headers);
    const invite = await createInvite(id, who?.id ?? null);

    return json({
      username: target.username,
      // Clear token, shown once (only its hash is stored).
      invite: { token: invite.token, expiresAt: invite.expiresAt.toISOString() },
    });
  } catch (err) {
    return serverError(err);
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const id = Number.parseInt((await params).id, 10);
    if (!Number.isFinite(id)) return badRequest("Invalid id");
    await q("DELETE FROM user_invites WHERE user_id = $1", [id]);
    return json({ ok: true });
  } catch (err) {
    return serverError(err);
  }
}
