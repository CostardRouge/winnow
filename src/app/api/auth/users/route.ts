// User management (admin-only — enforced centrally in src/proxy.ts, every
// method: even listing accounts is sensitive).
//   GET  /api/auth/users → all accounts (never the password hashes), each with
//        its invite state (pending link expiry, password set or not).
//   POST /api/auth/users { username, role, displayName? } → create WITHOUT a
//        password and return a one-time invite link: the person chooses their
//        own password by opening it — the admin never knows nor types it.
import { NextRequest } from "next/server";
import { z } from "zod";
import { many, one } from "@/lib/db";
import {
  USERNAME_RE,
  createInvite,
  identityFromHeaders,
  normalizeUsername,
  type UserRow,
} from "@/lib/auth";
import { json, badRequest, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

type ListRow = UserRow & {
  password_set: boolean;
  invite_expires_at: string | null;
};

function publicUser(u: ListRow) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    role: u.role,
    disabled: u.disabled,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
    passwordSet: u.password_set,
    // Live (non-expired) invite only: an expired link reads as "none".
    inviteExpiresAt: u.invite_expires_at,
  };
}

export async function GET() {
  try {
    const rows = await many<ListRow>(
      `SELECT u.id, u.username, u.display_name, u.role, u.disabled,
              u.created_at, u.last_login_at,
              (u.password_hash IS NOT NULL) AS password_set,
              CASE WHEN i.expires_at > now() THEN i.expires_at END AS invite_expires_at
         FROM users u
         LEFT JOIN user_invites i ON i.user_id = u.id
        ORDER BY u.username`,
    );
    return json({ users: rows.map(publicUser) });
  } catch (err) {
    return serverError(err);
  }
}

const Body = z.object({
  username: z.string().min(3).max(32),
  role: z.enum(["admin", "editor", "viewer"]),
  displayName: z.string().max(100).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return badRequest("Invalid parameters", parsed.error.issues);
    const username = normalizeUsername(parsed.data.username);
    if (!USERNAME_RE.test(username))
      return badRequest(
        "Username must be 3-32 chars: letters, digits, dots, dashes, underscores",
      );

    const exists = await one("SELECT 1 FROM users WHERE username = $1", [username]);
    if (exists) return badRequest("Username already taken");

    const created = await one<UserRow>(
      `INSERT INTO users (username, display_name, password_hash, role)
       VALUES ($1, $2, NULL, $3)
       RETURNING id, username, display_name, role, disabled, created_at, last_login_at`,
      [username, parsed.data.displayName?.trim() || null, parsed.data.role],
    );
    if (!created) return serverError(new Error("user creation failed"));

    const who = identityFromHeaders(req.headers);
    const invite = await createInvite(created.id, who?.id ?? null);

    return json(
      {
        user: publicUser({
          ...created,
          password_set: false,
          invite_expires_at: invite.expiresAt.toISOString(),
        }),
        // The clear token appears ONLY here (we store just its hash): the UI
        // shows it once for the admin to copy, then it is gone for good.
        invite: {
          token: invite.token,
          expiresAt: invite.expiresAt.toISOString(),
        },
      },
      201,
    );
  } catch (err) {
    return serverError(err);
  }
}
