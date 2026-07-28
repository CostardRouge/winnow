// Request guard — every page and API route passes through here (Node runtime,
// so the session cookie is validated against Postgres directly). Replaces the
// old "trust the reverse proxy" posture: Traefik/Cloudflare still sit in
// front, but identity now lives in the app.
//
//   1. Static assets and the tiny public surface (login, auth handshake,
//      healthcheck) pass through untouched.
//   2. Everything else needs a valid session cookie: API calls get a 401 JSON,
//      page loads bounce to /login (with a safe return path).
//   3. The role policy (lib/authz.ts) is enforced centrally: viewers are
//      read-only, editors cull/import/export, admins run the infrastructure.
//   4. The validated identity is injected as x-winnow-user-* request headers
//      for handlers that need attribution — after stripping any incoming
//      spoof attempt of those same headers.
import { NextResponse, type NextRequest } from "next/server";
import {
  SESSION_COOKIE,
  HDR_USER_ID,
  HDR_USER_NAME,
  HDR_USER_ROLE,
  validateSession,
} from "@/lib/auth";
import { isPublicPath, requiredRole, roleAtLeast } from "@/lib/authz";

export const config = {
  // Everything except Next internals and the PWA static files. Keep in sync
  // with the public files under /public (sw.js, offline.html, icons).
  matcher: [
    "/((?!_next/|icons/|sw\\.js$|offline\\.html$|manifest\\.webmanifest$|favicon\\.ico$).*)",
  ],
};

function unauthorized(message: string, status: 401 | 403) {
  return NextResponse.json({ error: message }, { status });
}

export default async function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const isApi = pathname.startsWith("/api/");

  const token = req.cookies.get(SESSION_COOKIE)?.value ?? null;
  const user = token ? await validateSession(token) : null;

  if (isPublicPath(pathname)) {
    // A signed-in user has no business on the login screen.
    if (user && pathname === "/login")
      return NextResponse.redirect(new URL("/library", req.url));
    return NextResponse.next();
  }

  if (!user) {
    if (isApi) return unauthorized("authentication required", 401);
    // Bounce to login, remembering where the visit was headed. Path-only
    // (never a full URL) so it cannot be turned into an open redirect.
    const login = new URL("/login", req.url);
    if (req.method === "GET" && pathname !== "/")
      login.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(login);
  }

  const needed = requiredRole(req.method, pathname);
  if (!roleAtLeast(user.role, needed)) {
    if (isApi)
      return unauthorized(`requires the ${needed} role (you are ${user.role})`, 403);
    return NextResponse.redirect(new URL("/library", req.url));
  }

  // Pass the identity down to the route handlers — stripping the incoming
  // headers first so a client can never forge who they are.
  const headers = new Headers(req.headers);
  headers.delete(HDR_USER_ID);
  headers.delete(HDR_USER_NAME);
  headers.delete(HDR_USER_ROLE);
  headers.set(HDR_USER_ID, String(user.id));
  headers.set(HDR_USER_NAME, user.username);
  headers.set(HDR_USER_ROLE, user.role);
  return NextResponse.next({ request: { headers } });
}
