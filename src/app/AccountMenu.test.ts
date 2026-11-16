import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountMenu, type AccountMenuUser } from "./AccountMenu";

// The account menu's shape (lab of 2026-11-16, pick A): places, then how you
// sign in, then Sign out alone — and unlinking Sésame is never a row.

const noop = () => {};
const render = (user: AccountMenuUser) =>
  renderToStaticMarkup(
    createElement(AccountMenu, {
      user,
      version: "1.1.0",
      linkHref: "/api/auth/sesame/login?intent=link&next=%2Flibrary",
      onNavigate: noop,
      onChangePassword: noop,
      onSesameLinked: noop,
      onSignOut: noop,
    }),
  );

// The visible labels in order, from the markup.
const order = (html: string, labels: string[]) => labels.map((l) => html.indexOf(l));

test("groups the places, the sign-in and the exit, in that order", () => {
  const html = render({ name: "Steeve", role: "admin", sesame: { linked: true } });
  const at = order(html, ["Settings", "Users", "Sign-in", "Password", "Sésame", "account-sep", "Sign out", "Winnow v1.1.0"]);
  assert.ok(at.every((i) => i >= 0), `every label is drawn: ${at}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, "in that order");
});

test("shows Sésame's state and never offers to unlink from the menu", () => {
  const linked = render({ name: "Steeve", role: "admin", sesame: { linked: true } });
  assert.match(linked, /Sésame: linked/);
  assert.doesNotMatch(linked, /Unlink/);
  const unlinked = render({ name: "Steeve", role: "editor", sesame: { linked: false } });
  assert.match(unlinked, /href="\/api\/auth\/sesame\/login\?intent=link/);
  assert.doesNotMatch(unlinked, /Unlink/);
});

test("draws no Sésame row without Sésame, and no Users for a non-admin", () => {
  const html = render({ name: "Vanessa", role: "viewer", sesame: null });
  assert.doesNotMatch(html, /Sésame/);
  assert.doesNotMatch(html, />Users</);
  assert.match(html, /Password/);
});
