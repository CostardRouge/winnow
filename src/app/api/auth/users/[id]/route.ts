// Per-account admin actions (admin-only — enforced centrally in src/proxy.ts).
//   PATCH  /api/auth/users/:id { role?, disabled?, password?, displayName? }
//   DELETE /api/auth/users/:id
// Invariants:
//   * the library can never end up without an active admin — the last one
//     cannot be demoted, disabled or deleted;
//   * deleting your own account is refused (sign in as another admin to do it);
//   * a password reset or a disable revokes every session of the target.
import { NextRequest } from "next/server";
import { z } from "zod";
import { one } from "@/lib/db";
import {
  destroyUserSessions,
  hashPassword,
  identityFromHeaders,
  type UserRow,
} from "@/lib/auth";
import { json, badRequest, notFound, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

const Body = z.object({
  role: z.enum(["admin", "editor", "viewer"]).optional(),
  disabled: z.boolean().optional(),
  password: z.string().min(8).max(1024).optional(),
  displayName: z.string().max(100).nullable().optional(),
});

async function activeAdminCount(): Promise<number> {
  const row = await one<{ n: number }>(
    "SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND NOT disabled",
  );
  return row?.n ?? 0;
}

async function getUser(id: number): Promise<UserRow | null> {
  return one<UserRow>(
    `SELECT id, username, display_name, role, disabled, created_at, last_login_at
       FROM users WHERE id = $1`,
    [id],
  );
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const id = Number.parseInt((await params).id, 10);
    if (!Number.isFinite(id)) return badRequest("Invalid id");
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return badRequest("Invalid parameters", parsed.error.issues);
    const { role, disabled, password, displayName } = parsed.data;

    const target = await getUser(id);
    if (!target) return notFound("No such user");

    // Guard the last active admin against demotion/disabling.
    const losesAdmin =
      target.role === "admin" &&
      !target.disabled &&
      ((role !== undefined && role !== "admin") || disabled === true);
    if (losesAdmin && (await activeAdminCount()) <= 1)
      return badRequest("Cannot remove the last active admin");

    if (role !== undefined)
      await one("UPDATE users SET role = $2 WHERE id = $1", [id, role]);
    if (displayName !== undefined)
      await one("UPDATE users SET display_name = $2 WHERE id = $1", [
        id,
        displayName?.trim() || null,
      ]);
    if (disabled !== undefined) {
      await one("UPDATE users SET disabled = $2 WHERE id = $1", [id, disabled]);
      if (disabled) await destroyUserSessions(id);
    }
    if (password !== undefined) {
      await one("UPDATE users SET password_hash = $2 WHERE id = $1", [
        id,
        await hashPassword(password),
      ]);
      await destroyUserSessions(id); // the old password's sessions die with it
    }
    // A role change must reach the proxy's short-lived session cache promptly.
    if (role !== undefined && role !== target.role) await destroyUserSessions(id);

    const updated = await getUser(id);
    return json({
      user: updated && {
        id: updated.id,
        username: updated.username,
        displayName: updated.display_name,
        role: updated.role,
        disabled: updated.disabled,
        createdAt: updated.created_at,
        lastLoginAt: updated.last_login_at,
      },
    });
  } catch (err) {
    return serverError(err);
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const id = Number.parseInt((await params).id, 10);
    if (!Number.isFinite(id)) return badRequest("Invalid id");

    const who = identityFromHeaders(req.headers);
    if (who?.id === id)
      return badRequest("You cannot delete your own account");

    const target = await getUser(id);
    if (!target) return notFound("No such user");
    if (target.role === "admin" && !target.disabled && (await activeAdminCount()) <= 1)
      return badRequest("Cannot delete the last active admin");

    await destroyUserSessions(id);
    // Attribution columns (ratings.rated_by, export_jobs.created_by) are ON
    // DELETE SET NULL: the work stays, only the byline goes.
    await one("DELETE FROM users WHERE id = $1", [id]);
    return json({ ok: true });
  } catch (err) {
    return serverError(err);
  }
}
