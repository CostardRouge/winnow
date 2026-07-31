// Local accounts + cookie sessions (single shared library, per-user roles).
//
//   * Passwords: scrypt (node:crypto — no native addon to build in Docker),
//     per-user random salt, constant-time compare. Stored self-describing
//     ("scrypt$N$r$p$salt$hash") so parameters can be raised later without
//     invalidating existing hashes.
//   * Sessions: a 256-bit random token in an httpOnly cookie; Postgres stores
//     only its SHA-256 (a DB leak never leaks a usable cookie). Sliding
//     expiration — actively used sessions stay alive, abandoned ones lapse.
//   * Validation happens on EVERY request (src/proxy.ts), including each grid
//     thumbnail, so a tiny in-process cache (TTL a few seconds, same pattern
//     as lib/settings.ts) keeps the hot path off Postgres. Revocations
//     (logout, disable, password change) clear it explicitly.
import {
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  createHash,
  type ScryptOptions,
} from "node:crypto";
import { one, q } from "./db";
import type { UserRole } from "./authz";

// promisify() would lose the options-bearing overload, so wrap by hand.
function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  opts: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, opts, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

// --- Types ----------------------------------------------------------------

export type SessionUser = {
  id: number;
  username: string;
  displayName: string | null;
  role: UserRole;
};

export type UserRow = {
  id: number;
  username: string;
  display_name: string | null;
  role: UserRole;
  disabled: boolean;
  created_at: string;
  last_login_at: string | null;
};

// NULL password_hash = account created but invite not yet accepted; such an
// account cannot sign in (authenticate() falls through to the dummy hash).

// --- Cookie / identity plumbing -------------------------------------------

export const SESSION_COOKIE = "winnow_session";

// Identity injected by the request guard (src/proxy.ts) after validating the
// session, for route handlers that need "who is acting" (attribution, /users
// guards). The proxy STRIPS these from every incoming request before setting
// its own values, so a client can never forge them.
export const HDR_USER_ID = "x-winnow-user-id";
export const HDR_USER_NAME = "x-winnow-user-name";
export const HDR_USER_ROLE = "x-winnow-user-role";

// Reads the proxy-injected identity from a request/headers object. Returns
// null when unauthenticated (only possible on the few public routes).
export function identityFromHeaders(headers: Headers): SessionUser | null {
  const id = Number.parseInt(headers.get(HDR_USER_ID) ?? "", 10);
  const username = headers.get(HDR_USER_NAME);
  const role = headers.get(HDR_USER_ROLE) as UserRole | null;
  if (!Number.isFinite(id) || !username || !role) return null;
  if (role !== "admin" && role !== "editor" && role !== "viewer") return null;
  return { id, username, displayName: null, role };
}

// --- Password hashing (scrypt) --------------------------------------------

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = (await scrypt(password, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  }));
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64url"),
    hash.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const N = Number.parseInt(nStr, 10);
  const r = Number.parseInt(rStr, 10);
  const p = Number.parseInt(pStr, 10);
  if (![N, r, p].every((v) => Number.isInteger(v) && v > 0)) return false;
  try {
    const salt = Buffer.from(saltB64, "base64url");
    const expected = Buffer.from(hashB64, "base64url");
    const actual = (await scrypt(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: 256 * 1024 * 1024,
    }));
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// --- Sessions ---------------------------------------------------------------

// 30-day sliding window: any request inside it pushes the expiry back out
// (throttled below), so an active browser never gets logged out and a stale
// one lapses on its own.
const SESSION_TTL_MS = 30 * 24 * 3600_000;
// Refresh the DB row (last_seen + expiry) at most once a minute per session.
const TOUCH_EVERY_MS = 60_000;

function sha256hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export async function createSession(
  userId: number,
  userAgent?: string | null,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await q(
    `INSERT INTO auth_sessions (token_hash, user_id, expires_at, user_agent)
     VALUES ($1, $2, $3, $4)`,
    [sha256hex(token), userId, expiresAt.toISOString(), userAgent?.slice(0, 300) ?? null],
  );
  // Opportunistic pruning — dead sessions go on login, no cron needed.
  q("DELETE FROM auth_sessions WHERE expires_at < now()").catch(() => {});
  return { token, expiresAt };
}

export async function destroySession(token: string): Promise<void> {
  await q("DELETE FROM auth_sessions WHERE token_hash = $1", [sha256hex(token)]);
  cache.delete(sha256hex(token));
}

// Revoke every session of a user (disable, password reset, delete).
export async function destroyUserSessions(userId: number): Promise<void> {
  await q("DELETE FROM auth_sessions WHERE user_id = $1", [userId]);
  for (const [k, v] of cache) if (v.user?.id === userId) cache.delete(k);
}

// --- Validation (the per-request hot path) --------------------------------

type CacheEntry = { user: SessionUser | null; at: number };

// The proxy and the route handlers are separate bundles: each instantiates
// its own copy of this module. Anchor the cache on globalThis (same trick as
// db.ts's pool) so a revocation done in a route (logout, disable, password
// change) instantly invalidates the entry the proxy reads — otherwise the
// revoked cookie would keep passing until the TTL lapsed.
declare global {
  // eslint-disable-next-line no-var
  var __winnowAuthCache: Map<string, CacheEntry> | undefined;
  // eslint-disable-next-line no-var
  var __winnowAuthTouch: Map<string, number> | undefined;
}

const cache: Map<string, CacheEntry> = (globalThis.__winnowAuthCache ??=
  new Map());
const CACHE_TTL_MS = 10_000;
const CACHE_MAX = 1000;

const lastTouch: Map<string, number> = (globalThis.__winnowAuthTouch ??=
  new Map());

export async function validateSession(
  token: string,
): Promise<SessionUser | null> {
  const key = sha256hex(token);

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.user;

  const row = await one<{
    id: number;
    username: string;
    display_name: string | null;
    role: UserRole;
  }>(
    `SELECT u.id, u.username, u.display_name, u.role
       FROM auth_sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.expires_at > now()
        AND NOT u.disabled`,
    [key],
  );

  const user: SessionUser | null = row
    ? {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        role: row.role,
      }
    : null;

  if (cache.size >= CACHE_MAX) cache.clear(); // crude but bounded
  cache.set(key, { user, at: Date.now() });

  // Sliding expiration, throttled: at most one UPDATE per session per minute.
  if (user) {
    const t = lastTouch.get(key) ?? 0;
    if (Date.now() - t > TOUCH_EVERY_MS) {
      lastTouch.set(key, Date.now());
      q(
        `UPDATE auth_sessions
            SET last_seen_at = now(),
                expires_at = now() + ($2 || ' milliseconds')::interval
          WHERE token_hash = $1`,
        [key, String(SESSION_TTL_MS)],
      ).catch(() => {});
    }
  }

  return user;
}

// --- Login (credentials → session) ----------------------------------------

// Small in-memory brake on credential guessing: 10 failures per source+account
// per 15 minutes. Per-process (resets on deploy) — fine for a self-hosted app
// behind a tunnel; the goal is stopping dumb loops, not nation-states.
const FAIL_WINDOW_MS = 15 * 60_000;
const FAIL_MAX = 10;
const failures = new Map<string, number[]>();

export function loginThrottled(ip: string, username: string): boolean {
  const now = Date.now();
  const arr = (failures.get(`${ip}|${username}`) ?? []).filter(
    (t) => now - t < FAIL_WINDOW_MS,
  );
  return arr.length >= FAIL_MAX;
}

export function recordLoginFailure(ip: string, username: string): void {
  const keyed = `${ip}|${username}`;
  const now = Date.now();
  const arr = (failures.get(keyed) ?? []).filter((t) => now - t < FAIL_WINDOW_MS);
  arr.push(now);
  failures.set(keyed, arr);
  if (failures.size > 10_000) failures.clear(); // bounded
}

export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

export const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._-]{1,30})[a-z0-9]$/;

export async function authenticate(
  username: string,
  password: string,
): Promise<UserRow | null> {
  const user = await one<UserRow & { password_hash: string | null }>(
    "SELECT * FROM users WHERE username = $1",
    [normalizeUsername(username)],
  );
  // Hash even when the user is unknown (or has no password yet — invite not
  // accepted) so the response time does not reveal which usernames exist.
  const ok = await verifyPassword(
    password,
    user?.password_hash ??
      "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  );
  if (!user || user.disabled || !ok) return null;
  return user;
}

// --- Invites (one-time "set your password" links) ---------------------------
//
// The admin never chooses nor sees anyone's password: creating an account (or
// resetting a lost password) yields a single-use /invite/<token> URL to hand
// over out of band. Opening it lets the user set their own password. Only the
// token's SHA-256 is stored; re-issuing replaces the previous link (at most
// one live invite per user); accepting deletes the row and revokes every
// pre-existing session of the account.

const INVITE_TTL_MS = 7 * 24 * 3600_000;

export type InviteInfo = {
  userId: number;
  username: string;
  displayName: string | null;
};

export async function createInvite(
  userId: number,
  createdBy: number | null,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  // ON CONFLICT (user_id): re-issuing an invite invalidates the previous link.
  await q(
    `INSERT INTO user_invites (token_hash, user_id, created_by, expires_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE
       SET token_hash = EXCLUDED.token_hash,
           created_by = EXCLUDED.created_by,
           created_at = now(),
           expires_at = EXCLUDED.expires_at`,
    [sha256hex(token), userId, createdBy, expiresAt.toISOString()],
  );
  // Opportunistic pruning, same pattern as sessions — no cron needed.
  q("DELETE FROM user_invites WHERE expires_at < now()").catch(() => {});
  return { token, expiresAt };
}

// Valid = not expired, account still enabled. Returns who the link is for
// (shown on the accept screen), never anything sensitive.
export async function validateInvite(token: string): Promise<InviteInfo | null> {
  const row = await one<{
    user_id: number;
    username: string;
    display_name: string | null;
  }>(
    `SELECT u.id AS user_id, u.username, u.display_name
       FROM user_invites i
       JOIN users u ON u.id = i.user_id
      WHERE i.token_hash = $1
        AND i.expires_at > now()
        AND NOT u.disabled`,
    [sha256hex(token)],
  );
  return row
    ? { userId: row.user_id, username: row.username, displayName: row.display_name }
    : null;
}

// Sets the password and burns the link. Re-validates inside so a link cannot
// be used twice even by racing requests (the DELETE arbitrates: only the call
// that actually removes the row proceeds). Any session the account had before
// (e.g. pre-reset, possibly compromised) is revoked.
export async function acceptInvite(
  token: string,
  password: string,
): Promise<InviteInfo | null> {
  const info = await validateInvite(token);
  if (!info) return null;
  const burned = await one<{ user_id: number }>(
    "DELETE FROM user_invites WHERE token_hash = $1 RETURNING user_id",
    [sha256hex(token)],
  );
  if (!burned) return null; // lost the race — the other request won the link
  await q("UPDATE users SET password_hash = $2 WHERE id = $1", [
    info.userId,
    await hashPassword(password),
  ]);
  await destroyUserSessions(info.userId);
  return info;
}

export async function usersExist(): Promise<boolean> {
  const row = await one<{ n: number }>("SELECT count(*)::int AS n FROM users");
  return (row?.n ?? 0) > 0;
}
