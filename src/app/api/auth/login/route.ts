// POST /api/auth/login { username, password } → sets the session cookie.
// Public (cf. lib/authz.ts); lightly throttled against credential guessing.
import { NextRequest } from "next/server";
import { z } from "zod";
import { q } from "@/lib/db";
import {
  SESSION_COOKIE,
  authenticate,
  createSession,
  loginThrottled,
  normalizeUsername,
  recordLoginFailure,
} from "@/lib/auth";
import { json, badRequest, serverError, clientIp, cookieSecure } from "@/lib/api";

export const dynamic = "force-dynamic";

const Body = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(1024),
});

export async function POST(req: NextRequest) {
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return badRequest("Invalid parameters", parsed.error.issues);
    const username = normalizeUsername(parsed.data.username);
    const ip = clientIp(req);

    if (loginThrottled(ip, username))
      return json({ error: "Too many attempts — try again later" }, 429);

    const user = await authenticate(username, parsed.data.password);
    if (!user) {
      recordLoginFailure(ip, username);
      return json({ error: "Invalid username or password" }, 401);
    }

    const { token, expiresAt } = await createSession(
      user.id,
      req.headers.get("user-agent"),
    );
    await q("UPDATE users SET last_login_at = now() WHERE id = $1", [user.id]);

    const res = json({
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        role: user.role,
      },
    });
    res.cookies.set(SESSION_COOKIE, token, {
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
