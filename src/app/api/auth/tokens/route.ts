// App tokens (admin-only, every method — cf. lib/authz.ts; and unreachable
// WITH a token, so a token can never mint another).
//   GET  /api/auth/tokens → every token on the instance, never the secret:
//        its name, owner, ceiling, the role it runs as today, dates, and the
//        last four characters that let a person match it to what they pasted.
//   POST /api/auth/tokens { userId, name, role, agent?, expiresInDays } → mint one
//        and return the clear token ONCE (only its SHA-256 is stored).
//
// A token acts as its owner (see migration 0045 for why it is not an account
// of its own), so the owner is a choice here: an admin mints for any enabled
// account, and the ceiling is clamped to that account's role at birth. The
// role it runs as is recomputed on every request anyway (lib/auth.ts), so a
// later demotion of the owner still applies.
import { NextRequest } from "next/server";
import { z } from "zod";
import { many, one } from "@/lib/db";
import { createAccessToken, identityFromHeaders, type UserRow } from "@/lib/auth";
import { cappedRole, type TokenRole, type UserRole } from "@/lib/authz";
import { json, badRequest, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

type ListRow = {
  id: number;
  name: string;
  hint: string;
  role: TokenRole;
  agent: boolean;
  user_id: number;
  owner_username: string;
  owner_display_name: string | null;
  owner_role: UserRole;
  owner_disabled: boolean;
  created_by_username: string | null;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  expired: boolean;
};

function publicToken(t: ListRow) {
  return {
    id: t.id,
    name: t.name,
    hint: t.hint,
    role: t.role,
    // Minted for an agent (an MCP client, migration 0048): its writes are
    // stamped as an agent's.
    agent: t.agent,
    // What a request with it runs as TODAY — lower than `role` when the owner
    // was demoted after minting.
    effectiveRole: cappedRole(t.owner_role, t.role),
    owner: {
      id: t.user_id,
      username: t.owner_username,
      displayName: t.owner_display_name,
      disabled: t.owner_disabled,
    },
    createdBy: t.created_by_username,
    createdAt: t.created_at,
    expiresAt: t.expires_at,
    lastUsedAt: t.last_used_at,
    // A refused token stays listed (so its name still explains the 401 the
    // app got) until someone revokes it.
    expired: t.expired,
  };
}

const LIST_SQL = `
  SELECT t.id, t.name, t.hint, t.role, t.agent, t.user_id,
         u.username AS owner_username, u.display_name AS owner_display_name,
         u.role AS owner_role, u.disabled AS owner_disabled,
         c.username AS created_by_username,
         t.created_at, t.expires_at, t.last_used_at,
         (t.expires_at IS NOT NULL AND t.expires_at <= now()) AS expired
    FROM access_tokens t
    JOIN users u ON u.id = t.user_id
    LEFT JOIN users c ON c.id = t.created_by`;

export async function GET() {
  try {
    const rows = await many<ListRow>(
      `${LIST_SQL} ORDER BY u.username, t.created_at DESC`,
    );
    return json({ tokens: rows.map(publicToken) });
  } catch (err) {
    return serverError(err);
  }
}

const Body = z.object({
  userId: z.number().int().positive(),
  name: z.string().trim().min(1).max(80),
  role: z.enum(["viewer", "editor"]),
  // For an agent (an MCP client): same caps, its writes marked as an agent's.
  agent: z.boolean().default(false),
  // null = no expiry. Ten years is "never" said with a date; past that, say
  // null.
  expiresInDays: z.number().int().min(1).max(3650).nullable(),
});

export async function POST(req: NextRequest) {
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return badRequest("Invalid parameters", parsed.error.issues);
    const { userId, name, role, agent, expiresInDays } = parsed.data;

    const owner = await one<UserRow>(
      `SELECT id, username, display_name, role, disabled, created_at, last_login_at
         FROM users WHERE id = $1`,
      [userId],
    );
    if (!owner) return badRequest("No such account");
    // It would be refused on its first request anyway (the lookup joins
    // NOT u.disabled) — say so now rather than hand out a dead token.
    if (owner.disabled)
      return badRequest("Enable the account before giving it a token");

    const who = identityFromHeaders(req.headers);
    const { token, row } = await createAccessToken({
      userId,
      name,
      // Never above the owner: a viewer's token asked as read-write is born
      // read-only rather than stored as a promise the lookup would break.
      role: cappedRole(owner.role, role) as TokenRole,
      agent,
      expiresAt:
        expiresInDays == null
          ? null
          : new Date(Date.now() + expiresInDays * 24 * 3600_000),
      createdBy: who?.id ?? null,
    });

    const listed = await one<ListRow>(`${LIST_SQL} WHERE t.id = $1`, [row.id]);
    return json(
      {
        token: listed && publicToken(listed),
        // The clear token appears ONLY here: the UI shows it once, then it is
        // gone for good. Lost = revoke and mint another.
        secret: token,
      },
      201,
    );
  } catch (err) {
    return serverError(err);
  }
}
