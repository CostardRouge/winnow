// Invite acceptance — the only public surface beside login/setup (cf.
// lib/authz.ts): the 256-bit single-use token in the URL is itself the
// credential, so no session is required.
//   GET  /api/auth/invite/:token → who the link is for (the accept screen
//        greets the person by name), or 404 when unknown/expired/used.
//   POST /api/auth/invite/:token { password } → sets the password, burns the
//        link, revokes any pre-existing session of the account and signs the
//        browser in on the spot.
import { NextRequest } from "next/server";
import { z } from "zod";
import { q } from "@/lib/db";
import { SESSION_COOKIE, acceptInvite, createSession, validateInvite } from "@/lib/auth";
import { json, badRequest, notFound, serverError, cookieSecure } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    const info = await validateInvite((await params).token);
    if (!info) return notFound("This invite link is invalid or has expired");
    return json({
      invite: { username: info.username, displayName: info.displayName },
    });
  } catch (err) {
    return serverError(err);
  }
}

const Body = z.object({ password: z.string().min(8).max(1024) });

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return badRequest("Invalid parameters", parsed.error.issues);

    const info = await acceptInvite((await params).token, parsed.data.password);
    if (!info) return notFound("This invite link is invalid or has expired");

    const { token: session, expiresAt } = await createSession(
      info.userId,
      req.headers.get("user-agent"),
    );
    await q("UPDATE users SET last_login_at = now() WHERE id = $1", [info.userId]);

    const res = json({ ok: true, username: info.username });
    res.cookies.set(SESSION_COOKIE, session, {
      httpOnly: true,
      sameSite: "lax",
      secure: cookieSecure(req),
      path: "/",
      expires: expiresAt,
    });
    return res;
  } catch (err) {
    return serverError(err);
  }
}
