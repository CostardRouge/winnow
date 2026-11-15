// GET /api/auth/sesame/callback — Sésame's answer. Public (cf. lib/authz.ts).
// The code is exchanged with the verifier this browser's flow cookie kept;
// openid-client checks the state and the ID token. Then:
//   * login: the account linked to this Sésame identity gets the SAME session
//     cookie as the password (lib/auth createSession) — or /login says why not;
//   * link:  the signed-in account is linked to this identity.
// Who may reach this point with a code is Sésame's decision: a person not
// given access to the app `winnow` there is refused and never comes back.
import { NextRequest, NextResponse } from "next/server";
import * as oidc from "openid-client";
import { SESSION_COOKIE, createSession, validateSession } from "@/lib/auth";
import { config } from "@/lib/config";
import { q } from "@/lib/db";
import { cookieSecure } from "@/lib/api";
import { linkSesame, sesameClient, userBySesameSub } from "@/lib/sesame";
import {
  SESAME_FLOW_COOKIE,
  SESAME_FLOW_PATH,
  type SesameError,
  originFrom,
  readFlow,
} from "@/lib/sesameFlow";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const here = originFrom(req.headers, req.nextUrl.origin);
  const sesame = config.sesame;
  const flow = sesame ? readFlow(req.cookies.get(SESAME_FLOW_COOKIE)?.value, sesame.clientSecret) : null;
  const done = (to: string) => {
    const res = NextResponse.redirect(new URL(to, here), 303);
    res.cookies.set(SESAME_FLOW_COOKIE, "", { path: SESAME_FLOW_PATH, maxAge: 0 });
    return res;
  };
  const failed = (why: SesameError) =>
    done(`/login?next=${encodeURIComponent(flow?.next ?? "/library")}&sesame=${why}`);

  if (!sesame) return done("/login");
  if (!flow) return failed("expired");
  // An `error` instead of a `code`: Sésame refused this person.
  if (req.nextUrl.searchParams.has("error")) return failed("refused");

  let sub: string;
  try {
    // The URL as the browser called it: the redirect_uri must match exactly.
    const current = new URL(`${here}${req.nextUrl.pathname}${req.nextUrl.search}`);
    const tokens = await oidc.authorizationCodeGrant(await sesameClient(sesame), current, {
      pkceCodeVerifier: flow.verifier,
      expectedState: flow.state,
    });
    const claimed = tokens.claims()?.sub;
    if (!claimed) return failed("failed");
    sub = claimed;
  } catch {
    return failed("failed");
  }

  if (flow.intent === "link") {
    const token = req.cookies.get(SESSION_COOKIE)?.value;
    const me = token ? await validateSession(token) : null;
    if (!me) return failed("expired");
    const result = await linkSesame(me.id, sub);
    const sep = flow.next.includes("?") ? "&" : "?";
    return done(`${flow.next}${sep}sesame=${result === "linked" ? "linked" : "taken"}`);
  }

  const user = await userBySesameSub(sub);
  if (!user) return failed("unlinked");
  if (user.disabled) return failed("disabled");
  const { token, expiresAt } = await createSession(user.id, req.headers.get("user-agent"));
  await q("UPDATE users SET last_login_at = now() WHERE id = $1", [user.id]);
  const res = done(flow.next);
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(req),
    path: "/",
    expires: expiresAt,
  });
  return res;
}
