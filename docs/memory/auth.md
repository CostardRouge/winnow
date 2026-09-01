# Authentication & authorization

Read before touching login, invites, sessions, roles, `src/proxy.ts` or `src/lib/{auth,authz,roles}.ts`.

Seeded 2026-08-20 from `src/proxy.ts`, `src/lib/auth.ts`, `src/lib/authz.ts` and `README.md` "Authentication / access". The README section is the user-facing description; this file keeps the invariants a change can break.

## Identity moved into the app; the reverse proxy is no longer the gate (2026-08-20)

**Decision**: Winnow carries its own accounts and sessions. The previous posture — trust Traefik's basic auth — is superseded; Traefik and the Cloudflare Tunnel still sit in front and the layers stack fine, but they are no longer what decides who you are.

**How to apply**: never reintroduce an "if it reached us, it is authorized" assumption for a new route or a new front-end proxy.

## Enforcement is central and in one place (2026-08-20)

**Decision**: `src/proxy.ts` is the request guard every page and API route passes through, on the **Node runtime** so it can validate the session cookie against Postgres directly. Its `config.matcher` excludes only Next internals and the PWA static files (`/_next`, `/icons`, `sw.js`, `offline.html`, `manifest.webmanifest`, `favicon.ico`). The role policy itself lives in `src/lib/authz.ts`, which is pure and dependency-free so the guard and any route wanting a second opinion share the exact same rules.

**Why**: one map from (method, pathname) to minimum role is auditable; per-route checks drift.

**How to apply**: a new API prefix inherits the default policy — every GET is viewer-visible, every mutation needs editor — so if it should be admin-only, add it to `ADMIN_WRITE_PREFIXES` or `ADMIN_ONLY_PREFIXES` in `authz.ts`, not to the handler. Adding a public file under `/public` means updating the proxy matcher to match. *(Inferred from the file's location and shape: `src/proxy.ts` is wired by Next 16's filename convention for the middleware entrypoint — there is no `src/middleware.ts` and nothing references it explicitly. Unconfirmed against the Next docs.)*

**Trap**: the guard injects the validated identity as `x-winnow-user-*` request headers **after stripping any incoming header of the same name**. A handler may trust those headers only because of that strip — do not move the injection without the strip.

## Roles: viewer < editor < admin, with two deliberate exceptions (2026-08-20)

**Decision**: viewer reads everything in the shared library; editor adds the culling/ingest verbs (ratings, tags, trash, geotag, import, upload, export); admin adds infrastructure (volumes, settings, scan control, pipeline, purge, integrity/reconcile, user management).

**The exceptions, both intentional**: GETs under the pipeline and volumes prefixes stay viewer-visible because those pages are dashboards everyone may read — only their mutations are admin. Conversely `/api/db/backup` is admin **even as a GET**, because a database dump is the whole library including password hashes and invite tokens.

**How to apply**: when adding a read endpoint, ask what a dump of its response contains before letting the every-GET-is-viewer default stand.

## Passwords never travel; only hashes are stored (2026-08-20)

**Decision**: passwords are scrypt-hashed via `node:crypto` (chosen so Docker builds no native addon) into a self-describing `scrypt$N$r$p$salt$hash` string, so the parameters can be raised later without invalidating existing hashes. Sessions are a 256-bit random token in an `httpOnly`, `SameSite=Lax`, `Secure`-behind-https cookie; Postgres stores only its SHA-256, so a database leak never yields a usable cookie. The window is 30 days and **sliding** — any request inside it pushes the expiry out, so an active browser is never logged out.

**Invite flow**: an admin creates an account without a password and gets a single-use, 7-day link (`/invite/<token>`); the person chooses their own password, so the admin never knows nor types it and a link that leaks after use is worthless. Only the token's SHA-256 is stored; re-issuing replaces the pending link, and a pending link can be revoked. A password reset is the same mechanism, and accepting it revokes every existing session.

**How to apply**: keep the "store only the hash" invariant for any new credential or token. Anything that revokes access (logout, password change, disabling an account) must revoke sessions **server-side**, not just clear a cookie. Note the constant-time-ish detail already in the code: a dummy scrypt hash is verified when the user does not exist, so a missing account and a wrong password cost the same time.

**First run**: with no account in the database, `/login` becomes a one-time "create the administrator" form (`/api/auth/setup`) that locks itself as soon as one user exists. `/invite/<token>` is public because the token *is* the credential.

## Attribution is recorded where it matters (2026-08-20)

**Decision**: `ratings.rated_by` and `export_jobs.created_by` record which account acted.

**How to apply**: a new verb that changes shared curation state should record its actor the same way — the library is multi-user and "who rejected this frame" is a question that gets asked.

## A trusted client app gets CORS, and CORS grants nothing (2026-08-31)

**Decision**: Atelier — the editing half of the maintainer's stack, a static browser app at `atelier.steeve.website` — calls this API cross-origin **with the session cookie**. That works without any new credential because `SameSite` is judged on the *site* (`steeve.website`), not the origin: a sibling subdomain is cross-origin but same-site, so `Lax` lets the cookie travel. All Winnow adds is the CORS answer (`src/lib/cors.ts`, pure like `authz.ts`; wired in `src/proxy.ts`; `CORS_ALLOWED_ORIGINS` in `config.ts`, empty by default) and a `GET /api/capabilities` fact sheet the client reads on connect.

**Why**: the alternative was a Bearer-token system — a table, a mint/revoke UI and a branch in the request guard — in a repository with no tests, for a client that already has a valid session. Deferred until a genuinely *foreign* origin needs access; `capabilities.auth.methods` is where `token`/`oauth2` would appear when built.

**Invariants, in the order forgetting them bites**:
- **The preflight is answered BEFORE the session check.** An `OPTIONS` carries no cookie; behind the guard it would 401 and every cross-origin call would die unreadably. It is the one path in `proxy.ts` that returns before `validateSession`, and it returns 204 with headers only — it never touches data.
- **Exact origins only, never `*`, never a pattern.** With credentials the browser refuses a wildcard; a `*.steeve.website` match would extend the cookie to anything under the site. `originListEnv` rejects a path or a bare host at boot (and is not `listEnv`, which splits on `:` — every origin contains one).
- **`Access-Control-Expose-Headers` must name `Content-Range`, `Content-Length`, `Accept-Ranges`.** Without them a Range fetch "works" while the client cannot read the 206's bounds — video seeking silently fails.
- The **401/403 are readable cross-origin on purpose** (they carry the CORS headers): a client must be able to tell "not signed in" from "blocked" and offer a sign-in link.
- There is still **no CSRF token**; `SameSite=Lax` is the whole protection. Allowing credentialed cross-origin requests widens that surface, which is why the allowlist is one exact origin, not a wildcard. Do not loosen it to make a dev setup convenient.
- `/api/capabilities` states **facts about the code as it is** (`rangeOnOriginals: false`, `documents.bucket: false`, `scheduling.reminders: false`). Flip a flag when the feature lands, never before; add fields, never rename them.
