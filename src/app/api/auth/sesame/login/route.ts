// GET /api/auth/sesame/login?next=/path[&intent=link] → Sésame's sign-in.
// Public (cf. lib/authz.ts): the way in for someone not signed in. With
// intent=link it starts linking the CURRENT account (a valid session cookie
// is required, else back to /login) — the only way an account gets linked.
import { NextRequest, NextResponse } from "next/server";
import * as oidc from "openid-client";
import { SESSION_COOKIE, validateSession } from "@/lib/auth";
import { config } from "@/lib/config";
import { sesameClient } from "@/lib/sesame";
import {
  SESAME_CALLBACK_PATH,
  SESAME_FLOW_COOKIE,
  SESAME_FLOW_PATH,
  SESAME_FLOW_SECONDS,
  originFrom,
  safeNext,
  signFlow,
} from "@/lib/sesameFlow";
import { cookieSecure } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const here = originFrom(req.headers, req.nextUrl.origin);
  const sesame = config.sesame;
  const next = safeNext(req.nextUrl.searchParams.get("next"));
  if (!sesame) return NextResponse.redirect(new URL("/login", here), 303);
  const intent = req.nextUrl.searchParams.get("intent") === "link" ? "link" : "login";
  if (intent === "link") {
    const token = req.cookies.get(SESSION_COOKIE)?.value;
    if (!token || !(await validateSession(token)))
      return NextResponse.redirect(new URL(`/login?next=${encodeURIComponent(next)}`, here), 303);
  }
  try {
    const client = await sesameClient(sesame);
    const verifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const target = oidc.buildAuthorizationUrl(client, {
      redirect_uri: `${here}${SESAME_CALLBACK_PATH}`,
      // `role`: the person's role in Sésame's app `winnow`, applied to the
      // linked account at sign-in (lib/sesameRole.ts).
      scope: "openid profile email role",
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
      state,
    });
    const res = NextResponse.redirect(target, 303);
    res.cookies.set(
      SESAME_FLOW_COOKIE,
      signFlow({ state, verifier, next, intent, exp: Date.now() + SESAME_FLOW_SECONDS * 1000 }, sesame.clientSecret),
      { httpOnly: true, sameSite: "lax", secure: cookieSecure(req), path: SESAME_FLOW_PATH, maxAge: SESAME_FLOW_SECONDS },
    );
    return res;
  } catch {
    // Sésame unreachable: say so on /login rather than a raw 500.
    return NextResponse.redirect(new URL(`/login?next=${encodeURIComponent(next)}&sesame=failed`, here), 303);
  }
}
