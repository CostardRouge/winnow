// Pins the role policy as it stands, so a change to lib/authz.ts that moves a
// route between roles shows up as a failing line here rather than in
// production. Pure: no database, no server.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cappedRole,
  isPublicPath,
  queryTokenAllowed,
  requiredRole,
  roleAtLeast,
  tokenMayReach,
} from "./authz";

test("every GET is viewer, every mutation editor, by default", () => {
  assert.equal(requiredRole("GET", "/api/assets"), "viewer");
  assert.equal(requiredRole("HEAD", "/api/assets/12/thumb"), "viewer");
  assert.equal(requiredRole("POST", "/api/assets/delete"), "editor");
  assert.equal(requiredRole("PATCH", "/api/assets/12/rating"), "editor");
  assert.equal(requiredRole("delete", "/api/exports/3"), "editor");
});

test("infrastructure prefixes: mutations admin, reads stay viewer", () => {
  assert.equal(requiredRole("POST", "/api/purge"), "admin");
  assert.equal(requiredRole("GET", "/api/purge"), "viewer");
  assert.equal(requiredRole("DELETE", "/api/roots/4"), "admin");
  assert.equal(requiredRole("POST", "/api/pipeline/ml-backfill"), "admin");
  assert.equal(requiredRole("POST", "/api/failures/duplicates/keep"), "admin");
});

test("admin-only prefixes hold for every method", () => {
  for (const p of [
    "/api/db/backup",
    "/api/db/backup/files/winnow-1.sql.gz",
    "/api/auth/users",
    "/api/auth/tokens/7",
    "/users",
    "/users/tokens",
    "/settings/instance",
  ])
    assert.equal(requiredRole("GET", p), "admin", p);
});

test("self-service prefixes are viewer even when mutating", () => {
  assert.equal(requiredRole("POST", "/api/auth/logout"), "viewer");
  assert.equal(requiredRole("PATCH", "/api/auth/me"), "viewer");
  assert.equal(requiredRole("PUT", "/api/apps/atelier/docs/trip-1"), "viewer");
});

test("a prefix matches whole path segments only", () => {
  // `/api/rootsx` is not under `/api/roots`.
  assert.equal(requiredRole("POST", "/api/rootsx"), "editor");
  assert.equal(isPublicPath("/loginx"), false);
  assert.equal(isPublicPath("/api/auth/meow"), false);
});

test("the public surface is exactly the handshake and the probe", () => {
  for (const p of [
    "/login",
    "/invite/abc",
    "/api/auth/login",
    "/api/auth/setup",
    "/api/auth/invite/abc",
    "/api/health",
  ])
    assert.equal(isPublicPath(p), true, p);
  for (const p of ["/", "/library", "/api/auth/me", "/api/assets", "/api/auth/tokens"])
    assert.equal(isPublicPath(p), false, p);
});

test("roles are ordered and a token role is a ceiling", () => {
  assert.equal(roleAtLeast("admin", "editor"), true);
  assert.equal(roleAtLeast("viewer", "editor"), false);
  assert.equal(cappedRole("admin", "editor"), "editor");
  assert.equal(cappedRole("viewer", "editor"), "viewer");
});

test("an app token reaches the API only, and nothing under /api/auth but GET me", () => {
  assert.equal(tokenMayReach("GET", "/api/assets"), true);
  assert.equal(tokenMayReach("GET", "/api/auth/me"), true);
  assert.equal(tokenMayReach("PATCH", "/api/auth/me"), false);
  assert.equal(tokenMayReach("POST", "/api/auth/tokens"), false);
  assert.equal(tokenMayReach("GET", "/library"), false);
});

test("a query-string token is honoured only on the media an element loads", () => {
  assert.equal(queryTokenAllowed("GET", "/api/assets/12/thumb"), true);
  assert.equal(queryTokenAllowed("HEAD", "/api/assets/12/proxy"), true);
  assert.equal(queryTokenAllowed("GET", "/api/sidecars/3/download"), true);
  assert.equal(queryTokenAllowed("POST", "/api/assets/12/thumb"), false);
  assert.equal(queryTokenAllowed("GET", "/api/assets/12"), false);
  assert.equal(queryTokenAllowed("GET", "/api/assets/abc/thumb"), false);
  assert.equal(queryTokenAllowed("GET", "/api/assets/12/thumb/extra"), false);
});
