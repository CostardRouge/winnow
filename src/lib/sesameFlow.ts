// The round trip to Sésame, the pure half (cf. lib/sesame.ts for the I/O).
//
// Between "Sign in with Sésame" and Sésame's answer, the browser keeps what
// the answer must match — the PKCE verifier, the state, where to go next and
// whether this is a sign-in or a link — in a short cookie, signed so it
// cannot be forged or edited. The signing key is derived from the client
// secret: no new secret to set, and it never leaves the server.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SESAME_FLOW_COOKIE = "winnow_sesame";
export const SESAME_FLOW_PATH = "/api/auth/sesame";
export const SESAME_CALLBACK_PATH = "/api/auth/sesame/callback";
export const SESAME_FLOW_SECONDS = 600;

export type SesameIntent = "login" | "link";

export type SesameFlow = {
  state: string;
  verifier: string;
  next: string;
  intent: SesameIntent;
  exp: number; // ms since the epoch
};

export { SESAME_ERRORS, type SesameError } from "./sesameMessages";

function keyFor(clientSecret: string): Buffer {
  return createHash("sha256").update(`winnow-sesame-flow:${clientSecret}`).digest();
}

function sign(payload: string, clientSecret: string): string {
  return createHmac("sha256", keyFor(clientSecret)).update(payload).digest("base64url");
}

export function signFlow(flow: SesameFlow, clientSecret: string): string {
  const payload = Buffer.from(JSON.stringify(flow)).toString("base64url");
  return `${payload}.${sign(payload, clientSecret)}`;
}

/** The flow a cookie carries, or null when it is absent, forged, edited or old. */
export function readFlow(
  raw: string | undefined,
  clientSecret: string,
  now: number = Date.now(),
): SesameFlow | null {
  if (!raw) return null;
  const dot = raw.indexOf(".");
  if (dot < 1) return null;
  const payload = raw.slice(0, dot);
  const given = Buffer.from(raw.slice(dot + 1));
  const expected = Buffer.from(sign(payload, clientSecret));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const flow = JSON.parse(Buffer.from(payload, "base64url").toString()) as SesameFlow;
    if (typeof flow.exp !== "number" || flow.exp < now) return null;
    if (flow.intent !== "login" && flow.intent !== "link") return null;
    if (typeof flow.state !== "string" || typeof flow.verifier !== "string") return null;
    return { ...flow, next: safeNext(flow.next) };
  } catch {
    return null;
  }
}

/** Only ever a path on this site: never a full URL, never `//host`. */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/library";
  return raw;
}

/** The site's origin as the browser sees it, behind Traefik and the tunnel. */
export function originFrom(headers: Headers, fallback: string): string {
  const host = headers.get("x-forwarded-host")?.split(",")[0]?.trim() || headers.get("host");
  if (!host) return fallback;
  const proto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || new URL(fallback).protocol.replace(":", "");
  return `${proto === "https" ? "https" : "http"}://${host}`;
}
