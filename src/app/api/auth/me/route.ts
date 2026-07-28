// GET   /api/auth/me → the signed-in account (identity + role, for the UI).
// PATCH /api/auth/me { displayName? } | { password, currentPassword } →
//   self-service profile edit. A password change revokes every other session
//   of the account and re-issues the current browser a fresh one.
import { NextRequest } from "next/server";
import { z } from "zod";
import { one, q } from "@/lib/db";
import {
  SESSION_COOKIE,
  createSession,
  destroyUserSessions,
  hashPassword,
  identityFromHeaders,
  verifyPassword,
} from "@/lib/auth";
import { json, badRequest, serverError, cookieSecure } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const who = identityFromHeaders(req.headers);
    if (!who) return json({ error: "authentication required" }, 401);
    const row = await one<{
      id: number;
      username: string;
      display_name: string | null;
      role: string;
    }>("SELECT id, username, display_name, role FROM users WHERE id = $1", [who.id]);
    if (!row) return json({ error: "authentication required" }, 401);
    return json({
      user: {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        role: row.role,
      },
    });
  } catch (err) {
    return serverError(err);
  }
}

const Body = z.object({
  displayName: z.string().max(100).nullable().optional(),
  password: z.string().min(8).max(1024).optional(),
  currentPassword: z.string().max(1024).optional(),
});

export async function PATCH(req: NextRequest) {
  try {
    const who = identityFromHeaders(req.headers);
    if (!who) return json({ error: "authentication required" }, 401);
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return badRequest("Invalid parameters", parsed.error.issues);
    const { displayName, password, currentPassword } = parsed.data;

    if (displayName !== undefined) {
      await q("UPDATE users SET display_name = $2 WHERE id = $1", [
        who.id,
        displayName?.trim() || null,
      ]);
    }

    if (password !== undefined) {
      // Changing one's own password always re-proves the current one, even
      // mid-session — a walked-away-from browser must not be enough.
      const row = await one<{ password_hash: string }>(
        "SELECT password_hash FROM users WHERE id = $1",
        [who.id],
      );
      if (!row || !(await verifyPassword(currentPassword ?? "", row.password_hash)))
        return json({ error: "Current password is incorrect" }, 403);
      await q("UPDATE users SET password_hash = $2 WHERE id = $1", [
        who.id,
        await hashPassword(password),
      ]);
      // Revoke everything (any possibly-leaked session dies with the old
      // password), then keep THIS browser signed in on a fresh token.
      await destroyUserSessions(who.id);
      const { token, expiresAt } = await createSession(
        who.id,
        req.headers.get("user-agent"),
      );
      const res = json({ ok: true });
      res.cookies.set(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: "lax",
        secure: cookieSecure(req),
        path: "/",
        expires: expiresAt,
      });
      return res;
    }

    return json({ ok: true });
  } catch (err) {
    return serverError(err);
  }
}
