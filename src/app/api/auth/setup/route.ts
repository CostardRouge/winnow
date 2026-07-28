// First-run bootstrap — only alive while the users table is EMPTY.
//   GET  /api/auth/setup → { setupNeeded } (the login page decides which form to show).
//   POST /api/auth/setup { username, password, displayName? } → creates the
//        first account (admin) and signs it in. As soon as one user exists the
//        endpoint locks itself: any later call is a 403.
// Public by necessity (there is nobody to authenticate yet) — cf. lib/authz.ts.
import { NextRequest } from "next/server";
import { z } from "zod";
import { one } from "@/lib/db";
import {
  SESSION_COOKIE,
  USERNAME_RE,
  createSession,
  hashPassword,
  normalizeUsername,
  usersExist,
} from "@/lib/auth";
import { json, badRequest, serverError, cookieSecure } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return json({ setupNeeded: !(await usersExist()) });
  } catch (err) {
    return serverError(err);
  }
}

const Body = z.object({
  username: z.string().min(3).max(32),
  password: z.string().min(8).max(1024),
  displayName: z.string().max(100).optional(),
});

export async function POST(req: NextRequest) {
  try {
    if (await usersExist())
      return json({ error: "Setup already completed" }, 403);

    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return badRequest("Invalid parameters", parsed.error.issues);
    const username = normalizeUsername(parsed.data.username);
    if (!USERNAME_RE.test(username))
      return badRequest(
        "Username must be 3-32 chars: letters, digits, dots, dashes, underscores",
      );

    // The unique index on username is the real race arbiter: if two setup
    // calls land together, the second INSERT fails and reports cleanly.
    const created = await one<{ id: number; username: string; role: string }>(
      `INSERT INTO users (username, display_name, password_hash, role)
       VALUES ($1, $2, $3, 'admin')
       RETURNING id, username, role`,
      [
        username,
        parsed.data.displayName?.trim() || null,
        await hashPassword(parsed.data.password),
      ],
    );
    if (!created) return serverError(new Error("user creation failed"));

    const { token, expiresAt } = await createSession(
      created.id,
      req.headers.get("user-agent"),
    );
    const res = json({
      user: { id: created.id, username: created.username, role: created.role },
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
