// POST /api/auth/logout → revokes the session server-side + clears the cookie.
import { NextRequest } from "next/server";
import { SESSION_COOKIE, destroySession } from "@/lib/auth";
import { json, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const token = req.cookies.get(SESSION_COOKIE)?.value;
    if (token) await destroySession(token);
    const res = json({ ok: true });
    res.cookies.delete(SESSION_COOKIE);
    return res;
  } catch (err) {
    return serverError(err);
  }
}
