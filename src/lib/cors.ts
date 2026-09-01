// Cross-origin access for a trusted client app (Atelier), and nothing else.
//
// Winnow's session is an httpOnly, SameSite=Lax cookie. A browser app served
// from a SIBLING subdomain (atelier.steeve.website → winnow.steeve.website) is
// cross-origin but same-SITE, so the cookie still travels — provided the
// response says that origin may read it. That is all this does: echo ONE
// exactly-allowlisted origin back with the credentials flag, and expose the
// headers a seeking <video> and a Range fetch need. Nothing here grants access;
// the session guard still decides who the request is.
//
// Pure and dependency-free, like lib/authz.ts, so src/proxy.ts (Node runtime)
// and any route wanting a second opinion share the same rules.
//
// Rules that are load-bearing, in order of how badly forgetting them bites:
//   1. Never echo `*`, and never match a pattern: with credentials, the browser
//      refuses a wildcard, and a subdomain wildcard would extend the cookie to
//      anything under the site. The list holds exact origins.
//   2. `Access-Control-Expose-Headers` MUST name Content-Range, Content-Length
//      and Accept-Ranges — omit them and a cross-origin Range request "works"
//      while the client can never see the 206's bounds, i.e. video seeking
//      silently fails.
//   3. The preflight (OPTIONS) carries no cookie, so it has to be answered
//      BEFORE the session guard, or every cross-origin call dies with a 401 the
//      client cannot even read.

// Origins are compared exactly after this normalisation, so a trailing slash
// or an uppercase host in the env does not turn the feature off by accident.
export function normalizeOrigin(raw: string): string {
  return raw.trim().toLowerCase().replace(/\/+$/, "");
}

export function isAllowedOrigin(
  origin: string | null,
  allowlist: readonly string[],
): origin is string {
  if (!origin) return false;
  const wanted = normalizeOrigin(origin);
  return allowlist.some((o) => normalizeOrigin(o) === wanted);
}

// What every cross-origin RESPONSE from an allowed origin carries. `Vary` is
// what keeps a shared cache from handing origin A's grant to origin B.
export function corsResponseHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Expose-Headers":
      "Content-Range, Content-Length, Accept-Ranges, ETag, Content-Disposition",
    Vary: "Origin",
  };
}

// The PREFLIGHT answer. Methods are the API's whole surface; headers echo what
// the browser asked for (Range, Content-Type, If-None-Match…) rather than a
// list that drifts. Ten minutes of caching keeps a scrubbing <video> from
// preflighting every seek.
export function corsPreflightHeaders(
  origin: string,
  requestedHeaders: string | null,
): Record<string, string> {
  return {
    ...corsResponseHeaders(origin),
    "Access-Control-Allow-Methods": "GET, HEAD, POST, PATCH, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": requestedHeaders?.trim() || "Content-Type",
    "Access-Control-Max-Age": "600",
  };
}

export function isPreflight(method: string, req: {
  headers: { get(name: string): string | null };
}): boolean {
  return (
    method.toUpperCase() === "OPTIONS" &&
    req.headers.get("access-control-request-method") !== null
  );
}
