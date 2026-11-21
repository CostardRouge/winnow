// The role a Sésame sign-in carries (migration 0060).
//
// Sésame's app `winnow` declares the roles viewer, editor and admin, and each
// member's role is chosen in Sésame's admin. The ID token carries it as the
// `role` claim (scope `role`) — and only while the app still declares that
// role: a retired role, or a member with none, sends no claim at all.
//
// The rules, in the order they bite:
//   * a LINKED account signing in through Sésame takes the claim's role when it
//     is one of the three — a hand edit on the Users page lasts until the next
//     Sésame sign-in, by design (Sésame is where the role is decided);
//   * no claim, or a value that is not one of the three, changes nothing:
//     never downgrade on absence (a role not chosen yet in Sésame must not
//     lock anyone out);
//   * never demote the LAST active admin this way: the admin is kept and the
//     refusal recorded (role_changes.kept = 'last_admin'), so a slip in
//     Sésame's admin cannot leave the library without anyone able to fix it;
//   * a change flushes the person's cache entries — sessions AND app tokens —
//     so the proxy reads the new role on the very next request. Sessions are
//     NOT revoked (unlike the Users page's edit): signing in on the phone
//     must not sign the desktop out. A token's ceiling is min(owner's role
//     now, token), so a demotion caps it at once and a promotion never lifts
//     it above what it was minted with.
// Password sign-ins never read or write any of this.
import type { PoolClient } from "pg";
import { forgetUserCache } from "./auth";
import type { UserRole } from "./authz";
import { tx } from "./db";

const ROLES: readonly UserRole[] = ["admin", "editor", "viewer"];

/** The claim's role, or null when it is absent or not one of Winnow's three. */
export function parseSesameRole(claim: unknown): UserRole | null {
  return typeof claim === "string" && (ROLES as readonly string[]).includes(claim)
    ? (claim as UserRole)
    : null;
}

export type SesameRoleOutcome =
  | { outcome: "absent" } // no claim: kept as is
  | { outcome: "invalid"; claim: unknown } // a value Winnow does not know: kept
  | { outcome: "same"; role: UserRole }
  | { outcome: "applied"; from: UserRole; to: UserRole }
  | { outcome: "kept_last_admin"; asked: UserRole };

/** Records one row of the role trail (role_changes). */
export async function recordRoleChange(
  client: Pick<PoolClient, "query">,
  row: {
    userId: number;
    from: UserRole;
    to: UserRole;
    source: "admin" | "sesame";
    actorId: number | null;
    kept?: "last_admin";
  },
): Promise<void> {
  await client.query(
    `INSERT INTO role_changes (user_id, from_role, to_role, source, actor_id, kept)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [row.userId, row.from, row.to, row.source, row.actorId, row.kept ?? null],
  );
}

/**
 * Applies the `role` claim of a Sésame sign-in to the linked account `userId`.
 * Call it after the account is known to be linked and enabled.
 */
export async function applySesameRole(userId: number, claim: unknown): Promise<SesameRoleOutcome> {
  if (claim === undefined || claim === null) return { outcome: "absent" };
  const role = parseSesameRole(claim);
  if (!role) return { outcome: "invalid", claim };

  const result = await tx(async (client): Promise<SesameRoleOutcome> => {
    // Lock the active admins, then the account: two demotions racing (two
    // admins signing in at once, or this beside a Users page edit) see each
    // other's write instead of both passing the count.
    const admins = await client.query<{ id: string }>(
      "SELECT id FROM users WHERE role = 'admin' AND NOT disabled ORDER BY id FOR UPDATE",
    );
    const me = await client.query<{ role: UserRole; disabled: boolean }>(
      "SELECT role, disabled FROM users WHERE id = $1 FOR UPDATE",
      [userId],
    );
    const current = me.rows[0];
    if (!current) return { outcome: "absent" };
    if (current.role === role) return { outcome: "same", role };
    if (current.role === "admin" && !current.disabled && role !== "admin" && admins.rows.length <= 1) {
      await recordRoleChange(client, {
        userId,
        from: current.role,
        to: role,
        source: "sesame",
        actorId: userId,
        kept: "last_admin",
      });
      return { outcome: "kept_last_admin", asked: role };
    }
    await client.query("UPDATE users SET role = $2 WHERE id = $1", [userId, role]);
    await recordRoleChange(client, { userId, from: current.role, to: role, source: "sesame", actorId: userId });
    return { outcome: "applied", from: current.role, to: role };
  });

  if (result.outcome === "applied") forgetUserCache(userId);
  if (result.outcome === "kept_last_admin")
    console.warn(
      `[sesame] user ${userId}: Sésame says ${result.asked}, kept admin — the last active admin is never demoted by a sign-in`,
    );
  return result;
}
