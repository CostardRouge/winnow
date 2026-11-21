// Sign-in through Sésame, the portfolio's identity provider (OpenID Connect).
//
// A second door beside the password, never a replacement: an account reaches
// it once it has LINKED its Sésame identity (`users.sesame_sub`, migration
// 0059) from a session already signed in with the password. Never matched by
// email — Sésame does not verify addresses, so an email match would hand an
// account to whoever registered that address there. Sésame says who and,
// through its memberships, whether this person may enter Winnow at all — and,
// since migration 0060, with which role (lib/sesameRole.ts). The protocol is openid-client's (OpenID Certified):
// PKCE, state, the ID token's signature, issuer, audience and expiry.
import * as oidc from "openid-client";
import { config } from "./config";
import { one, q } from "./db";

type SesameSettings = NonNullable<typeof config.sesame>;

declare global {
  // eslint-disable-next-line no-var
  var __winnowSesame: { key: string; client: Promise<oidc.Configuration> } | undefined;
}

/** The client, discovered once per issuer + id (route bundles share it). */
export function sesameClient(s: SesameSettings): Promise<oidc.Configuration> {
  const key = `${s.issuer}|${s.clientId}`;
  const cached = globalThis.__winnowSesame;
  if (cached?.key === key) return cached.client;
  const issuer = new URL(s.issuer);
  const local = issuer.protocol === "http:";
  const client = oidc
    .discovery(
      issuer,
      s.clientId,
      s.clientSecret,
      oidc.ClientSecretBasic(s.clientSecret),
      local ? { execute: [oidc.allowInsecureRequests] } : undefined,
    )
    .catch((error) => {
      // Do not cache a failure: Sésame may be restarting.
      globalThis.__winnowSesame = undefined;
      throw error;
    });
  globalThis.__winnowSesame = { key, client };
  return client;
}

export type LinkedUser = { id: number; disabled: boolean };

export async function userBySesameSub(sub: string): Promise<LinkedUser | null> {
  return one<LinkedUser>("SELECT id, disabled FROM users WHERE sesame_sub = $1", [sub]);
}

/** Links a Sésame identity to an account; refuses one already linked elsewhere. */
export async function linkSesame(userId: number, sub: string): Promise<"linked" | "taken"> {
  const other = await userBySesameSub(sub);
  if (other && other.id !== userId) return "taken";
  await q("UPDATE users SET sesame_sub = $2 WHERE id = $1", [userId, sub]);
  return "linked";
}

export async function unlinkSesame(userId: number): Promise<void> {
  await q("UPDATE users SET sesame_sub = NULL WHERE id = $1", [userId]);
}

export async function sesameLinked(userId: number): Promise<boolean> {
  const row = await one<{ linked: boolean }>("SELECT sesame_sub IS NOT NULL AS linked FROM users WHERE id = $1", [userId]);
  return Boolean(row?.linked);
}
