// Authorization policy — the single map from (method, pathname) to the
// minimum role required. Pure and dependency-free so both the request guard
// (src/proxy.ts) and any route wanting a second opinion share the exact same
// rules; nothing here touches the database.
//
// Roles are ordered: viewer < editor < admin.
//   viewer : every GET (browse the whole shared library, thumbs, downloads).
//   editor : the culling/ingest verbs — ratings, tags, trash, geotag, import,
//            upload, export, per-asset maintenance.
//   admin  : infrastructure verbs — volumes, settings, scan control, pipeline,
//            purge, integrity/reconcile, user management.

export type UserRole = "admin" | "editor" | "viewer";

const RANK: Record<UserRole, number> = { viewer: 0, editor: 1, admin: 2 };

export function roleAtLeast(role: UserRole, min: UserRole): boolean {
  return RANK[role] >= RANK[min];
}

// Paths reachable with NO session at all. Deliberately tiny: the login screen,
// the auth handshake, the first-run setup, the invite-acceptance screen (its
// bearer token IS the credential), and the Docker healthcheck probe.
// (Static assets — /_next, /icons, sw.js… — are excluded by the proxy matcher.)
const PUBLIC_PREFIXES = [
  "/login",
  "/invite",
  "/api/auth/login",
  "/api/auth/setup",
  "/api/auth/invite",
  "/api/health",
];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

// Prefixes whose MUTATIONS are infrastructure-level (admin). Everything else
// mutating falls to editor. GETs under these stay viewer-visible (the Pipeline
// and Volumes pages are dashboards everyone may read).
const ADMIN_WRITE_PREFIXES = [
  "/api/roots", // add/remove/re-type volumes
  "/api/settings", // rates, pairing prefs
  "/api/features", // which optional sections this instance offers
  "/api/scan", // scan control (pause/resume)
  "/api/index", // manual scans
  "/api/pipeline", // queue actions, backfills
  "/api/failures", // retry/discard failures, duplicate arbitration
  "/api/purge", // physical deletion — the most destructive verb
  "/api/reconcile",
  "/api/integrity",
];

// Prefixes where EVERY method is admin-only (reading the user list is already
// sensitive). The /users management page itself is guarded too, and so is
// minting app tokens (/api/auth/tokens): a token acts as its owner. A database
// dump is the whole library INCLUDING password hashes and invite tokens, so
// downloading one — a GET — is admin despite the every-GET-is-viewer default.
// Settings › Instance is the same class: it prints the effective environment —
// internal hostnames, the filesystem layout, which credentials exist — which is
// an operator's reference, not a reader's. It renders server-side with no
// endpoint behind it, so this prefix is the whole guard.
const ADMIN_ONLY_PREFIXES = [
  "/api/auth/users",
  "/api/auth/tokens",
  "/users",
  "/api/db/backup",
  "/settings/instance",
];

// Account self-service: any signed-in role, mutations included. Signing out
// and changing one's OWN password/display name are not library writes — a
// viewer must be able to do both (the "am I really me" proof is the current
// password, checked by the route itself, not the role). A client app's
// document bucket (/api/apps/…, migration 0041) is the same kind of thing:
// rows are scoped to user_id by the route, so a viewer owns its trips
// without being able to touch the library.
const SELF_SERVICE_PREFIXES = ["/api/auth/logout", "/api/auth/me", "/api/apps"];

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function requiredRole(method: string, pathname: string): UserRole {
  if (ADMIN_ONLY_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`)))
    return "admin";
  if (SELF_SERVICE_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`)))
    return "viewer";
  if (!MUTATING.has(method.toUpperCase())) return "viewer";
  if (ADMIN_WRITE_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`)))
    return "admin";
  return "editor";
}

// --- App tokens (migration 0045, lib/auth.ts) --------------------------------
//
// A token is a key to ONE person's account for a client app that cannot hold
// the session cookie (Atelier launched from a phone's home screen has a cookie
// jar of its own). It is not an account: the app must see the same per-user
// documents as that person's browser. What separates it from a session is
// here, and every rule narrows — none of them grants anything a session of
// the same account would not have:
//
//   1. its role is a CEILING: the request runs as min(owner, token), and
//      "admin" is not a ceiling a token can carry;
//   2. it reaches the API only — never a page — and never /api/auth/* beyond
//      reading who it is (no minting tokens, no password change, no cookie);
//   3. in the query string it is accepted only on the few GETs an <img> or a
//      <video> issues, because an element cannot send a header. Everywhere
//      else a query token is ignored, so it cannot leak into a JSON URL.

export type TokenRole = Exclude<UserRole, "admin">;

export function cappedRole(owner: UserRole, ceiling: TokenRole): UserRole {
  return RANK[owner] <= RANK[ceiling] ? owner : ceiling;
}

export function tokenMayReach(method: string, pathname: string): boolean {
  if (!pathname.startsWith("/api/")) return false;
  if (pathname === "/api/auth/me") {
    const m = method.toUpperCase();
    return m === "GET" || m === "HEAD";
  }
  return !pathname.startsWith("/api/auth/");
}

// RFC 6750 §2.3's name for it, so a client that knows OAuth knows this.
export const TOKEN_QUERY_PARAM = "access_token";

// The media an element loads by URL: a grid thumbnail, the video/photo proxy,
// the original, a sidecar. A query token costs something a header does not —
// it lands in the reverse proxy's access log and in the browser's history of
// that URL — so the list stays exactly as long as what an element fetches.
// Stated as patterns so /api/capabilities can print the same list it enforces.
export const QUERY_TOKEN_ROUTES = [
  "/api/assets/:id/thumb",
  "/api/assets/:id/proxy",
  "/api/assets/:id/download",
  "/api/sidecars/:id/download",
] as const;

const QUERY_TOKEN_RES = QUERY_TOKEN_ROUTES.map(
  (r) => new RegExp(`^${r.replace(":id", "\\d+")}$`),
);

export function queryTokenAllowed(method: string, pathname: string): boolean {
  const m = method.toUpperCase();
  if (m !== "GET" && m !== "HEAD") return false;
  return QUERY_TOKEN_RES.some((re) => re.test(pathname));
}
