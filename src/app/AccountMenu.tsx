import Link from "next/link";
import { Icons } from "./ui";

// The account popover's body, foot of the rail (lab of 2026-11-16, the
// maintainer's pick A: https://claude.ai/artifact/QjB2EKRDR3a6RT7B6HaYHx).
// Three groups instead of five equal rows: the places (Settings, Users), how
// you sign in (Password, Sésame — each with its own image and its state), and
// Sign out alone under a rule. Unlinking Sésame is never a row: the Sésame
// row opens a confirmation that says what it is linked to, so the rare,
// door-removing gesture no longer sits one row above the daily one.
//
// Pure (props in, markup out) so it is rendered in a test without a browser.

export type AccountMenuUser = {
  name: string;
  role: "admin" | "editor" | "viewer";
  // null: this instance has no Sésame (or the session is a token, which can
  // neither link nor unlink); else whether the account is linked.
  sesame: { linked: boolean } | null;
};

export function AccountMenu({
  user,
  version,
  linkHref,
  onNavigate,
  onChangePassword,
  onSesameLinked,
  onSignOut,
}: {
  user: AccountMenuUser;
  version: string;
  // Where "Link" goes: the round trip to Sésame and back to this page.
  linkHref: string;
  onNavigate: () => void;
  onChangePassword: () => void;
  // The linked row: opens the confirmation, never unlinks by itself.
  onSesameLinked: () => void;
  onSignOut: () => void;
}) {
  return (
    <div className="account-pop" role="menu">
      <div className="account-id">
        <span className="account-name">{user.name}</span>
        <span className="account-role">{user.role}</span>
      </div>

      <Link href="/settings" className="account-item" role="menuitem" onClick={onNavigate}>
        <span className="account-item-ic" aria-hidden>
          {Icons.settings}
        </span>
        Settings
      </Link>
      {user.role === "admin" && (
        <Link href="/users" className="account-item" role="menuitem" onClick={onNavigate}>
          <span className="account-item-ic" aria-hidden>
            {Icons.users}
          </span>
          Users
        </Link>
      )}

      <div className="account-group" role="group" aria-labelledby="account-signin">
        <div className="account-group-label" id="account-signin">
          Sign-in
        </div>
        <button type="button" className="account-item" role="menuitem" onClick={onChangePassword}>
          <span className="account-item-ic" aria-hidden>
            {Icons.key}
          </span>
          Password
          <span className="account-item-hint">Change</span>
        </button>
        {user.sesame &&
          (user.sesame.linked ? (
            <button
              type="button"
              className="account-item"
              role="menuitem"
              aria-label="Sésame: linked"
              onClick={onSesameLinked}
            >
              <span className="account-item-ic" aria-hidden>
                {Icons.sesame}
              </span>
              Sésame
              <span className="account-item-hint">
                <span className="account-state-dot" aria-hidden />
                linked
              </span>
            </button>
          ) : (
            // A full navigation: the round trip to Sésame and back.
            <a href={linkHref} className="account-item" role="menuitem" aria-label="Sésame: link">
              <span className="account-item-ic" aria-hidden>
                {Icons.sesame}
              </span>
              Sésame
              <span className="account-item-hint">Link</span>
            </a>
          ))}
      </div>

      <div className="account-sep" role="separator" />
      <button type="button" className="account-item" role="menuitem" onClick={onSignOut}>
        <span className="account-item-ic" aria-hidden>
          {Icons.signout}
        </span>
        Sign out
      </button>
      {/* Which build the instance runs, at the foot of the menu: a phone in
          hand has no other way to tell (CHANGELOG.md says what it brought). */}
      <div className="account-version">Winnow v{version}</div>
    </div>
  );
}
