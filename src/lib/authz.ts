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
  "/api/scan", // scan control (pause/resume)
  "/api/index", // manual scans
  "/api/pipeline", // queue actions, backfills
  "/api/failures", // retry/discard failures, duplicate arbitration
  "/api/purge", // physical deletion — the most destructive verb
  "/api/reconcile",
  "/api/integrity",
];

// Prefixes where EVERY method is admin-only (reading the user list is already
// sensitive). The /users management page itself is guarded too.
const ADMIN_ONLY_PREFIXES = ["/api/auth/users", "/users"];

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function requiredRole(method: string, pathname: string): UserRole {
  if (ADMIN_ONLY_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`)))
    return "admin";
  if (!MUTATING.has(method.toUpperCase())) return "viewer";
  if (ADMIN_WRITE_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`)))
    return "admin";
  return "editor";
}
