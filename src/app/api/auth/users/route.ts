// User management (admin-only — enforced centrally in src/proxy.ts, every
// method: even listing accounts is sensitive).
//   GET  /api/auth/users → all accounts (never the password hashes).
//   POST /api/auth/users { username, password, role, displayName? } → create.
import { NextRequest } from "next/server";
import { z } from "zod";
import { many, one } from "@/lib/db";
import {
  USERNAME_RE,
  hashPassword,
  normalizeUsername,
  type UserRow,
} from "@/lib/auth";
import { json, badRequest, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

function publicUser(u: UserRow) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    role: u.role,
    disabled: u.disabled,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
  };
}

export async function GET() {
  try {
    const rows = await many<UserRow>(
      `SELECT id, username, display_name, role, disabled, created_at, last_login_at
         FROM users ORDER BY username`,
    );
    return json({ users: rows.map(publicUser) });
  } catch (err) {
    return serverError(err);
  }
}

const Body = z.object({
  username: z.string().min(3).max(32),
  password: z.string().min(8).max(1024),
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
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, display_name, role, disabled, created_at, last_login_at`,
      [
        username,
        parsed.data.displayName?.trim() || null,
        await hashPassword(parsed.data.password),
        parsed.data.role,
      ],
    );
    if (!created) return serverError(new Error("user creation failed"));
    return json({ user: publicUser(created) }, 201);
  } catch (err) {
    return serverError(err);
  }
}
