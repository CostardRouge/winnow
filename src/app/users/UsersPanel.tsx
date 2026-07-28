"use client";

// User management table (admin-only page): create accounts, change roles,
// enable/disable, send invite links, delete. Nobody — not even the admin —
// types anyone else's password: creating an account (or resetting a lost
// password) yields a one-time /invite/<token> link to hand over out of band,
// and the person chooses their own password by opening it. The server enforces
// the invariants (last-active-admin protection, no self-delete) — the UI just
// surfaces them.
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { fetchJson } from "@/lib/fetchJson";
import { ConfirmDialog, EmptyState, Icons, LoadingState } from "../ui";
import type { UserRole } from "@/lib/authz";

type UserItem = {
  id: number;
  username: string;
  displayName: string | null;
  role: UserRole;
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  passwordSet: boolean;
  inviteExpiresAt: string | null; // live (non-expired) invite only
};

const ROLES: UserRole[] = ["viewer", "editor", "admin"];

const ROLE_HINT: Record<UserRole, string> = {
  viewer: "browse only",
  editor: "cull, import, export",
  admin: "everything + settings & users",
};

function fmtDate(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("en-GB");
}

export default function UsersPanel() {
  const [users, setUsers] = useState<UserItem[]>([]);
  const [me, setMe] = useState<{ id: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<UserItem | null>(null);
  // The one place a clear invite token ever lives client-side: this modal.
  const [inviteLink, setInviteLink] = useState<{
    username: string;
    url: string;
    expiresAt: string;
  } | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, whoami] = await Promise.all([
        fetchJson<{ users: UserItem[] }>("/api/auth/users"),
        fetchJson<{ user: { id: number } }>("/api/auth/me"),
      ]);
      setUsers(list.users);
      setMe(whoami.user);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function patch(u: UserItem, body: Record<string, unknown>) {
    setBusyId(u.id);
    setError(null);
    try {
      await fetchJson(`/api/auth/users/${u.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function remove(u: UserItem) {
    setBusyId(u.id);
    setError(null);
    try {
      await fetchJson(`/api/auth/users/${u.id}`, { method: "DELETE" });
      setDeleting(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  // (Re-)issue the one-time link — onboarding not opened in time, or a
  // password reset. Replaces any previous link for the account.
  async function issueInvite(u: UserItem) {
    setBusyId(u.id);
    setError(null);
    try {
      const r = await fetchJson<{
        username: string;
        invite: { token: string; expiresAt: string };
      }>(`/api/auth/users/${u.id}/invite`, { method: "POST" });
      setInviteLink({
        username: r.username,
        url: `${window.location.origin}/invite/${r.invite.token}`,
        expiresAt: r.invite.expiresAt,
      });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function revokeInvite(u: UserItem) {
    setBusyId(u.id);
    setError(null);
    try {
      await fetchJson(`/api/auth/users/${u.id}/invite`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <LoadingState label="Loading users…" />;

  return (
    <section>
      {error && <div className="error-box">{error}</div>}

      <div className="filterbar" style={{ justifyContent: "flex-end" }}>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          + Invite a user
        </button>
      </div>

      {users.length === 0 ? (
        <EmptyState
          icon={Icons.users}
          title="No users"
          hint="Create the first account to share the library."
        />
      ) : (
        <div className="vol-table-wrap">
          <table className="vol-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>Last sign-in</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} style={u.disabled ? { opacity: 0.55 } : undefined}>
                  <td>
                    <div className="vol-path">
                      {u.displayName?.trim() || u.username}
                      {me?.id === u.id && (
                        <span className="tag tag-origin" style={{ marginLeft: 8 }}>
                          you
                        </span>
                      )}
                    </div>
                    <div className="hint">@{u.username}</div>
                  </td>
                  <td>
                    <select
                      className="select"
                      value={u.role}
                      disabled={busyId === u.id}
                      onChange={(e) => patch(u, { role: e.target.value })}
                      title={ROLE_HINT[u.role]}
                      aria-label={`Role of ${u.username}`}
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r} — {ROLE_HINT[r]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="num">{fmtDate(u.lastLoginAt)}</td>
                  <td>
                    {u.disabled ? (
                      "disabled"
                    ) : u.passwordSet ? (
                      "active"
                    ) : u.inviteExpiresAt ? (
                      <>
                        invited
                        <div className="hint">
                          link expires {fmtDate(u.inviteExpiresAt)}
                        </div>
                      </>
                    ) : (
                      <>
                        no password
                        <div className="hint">send a new invite link</div>
                      </>
                    )}
                  </td>
                  <td>
                    <div className="vol-actions">
                      <button
                        className="btn btn-sm"
                        disabled={busyId === u.id || u.disabled}
                        onClick={() => issueInvite(u)}
                        title={
                          u.passwordSet
                            ? "One-time link that lets them set a NEW password (their old sessions are revoked when it is used)"
                            : "One-time link that lets them choose their password"
                        }
                      >
                        {u.passwordSet ? "Reset link" : "Invite link"}
                      </button>
                      {u.inviteExpiresAt && (
                        <button
                          className="btn btn-sm"
                          disabled={busyId === u.id}
                          onClick={() => revokeInvite(u)}
                          title="Invalidate the pending link without issuing a new one"
                        >
                          Revoke link
                        </button>
                      )}
                      <button
                        className="btn btn-sm"
                        disabled={busyId === u.id || me?.id === u.id}
                        onClick={() => patch(u, { disabled: !u.disabled })}
                        title={
                          me?.id === u.id
                            ? "You cannot disable your own account"
                            : undefined
                        }
                      >
                        {u.disabled ? "Enable" : "Disable"}
                      </button>
                      <button
                        className="btn btn-sm btn-danger"
                        disabled={busyId === u.id || me?.id === u.id}
                        onClick={() => setDeleting(u)}
                        title={
                          me?.id === u.id
                            ? "You cannot delete your own account"
                            : undefined
                        }
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <CreateUserModal
          onClose={() => setCreating(false)}
          onCreated={async (invite) => {
            setCreating(false);
            setInviteLink(invite);
            await load();
          }}
        />
      )}

      {inviteLink && (
        <InviteLinkModal invite={inviteLink} onClose={() => setInviteLink(null)} />
      )}

      <ConfirmDialog
        open={deleting != null}
        title="Delete this user?"
        message={
          <>
            <strong>@{deleting?.username}</strong> will no longer be able to sign
            in and every one of their sessions is revoked. Their past ratings and
            exports stay in the library (unattributed).
          </>
        }
        confirmLabel="Delete user"
        danger
        busy={busyId === deleting?.id}
        onConfirm={() => deleting && remove(deleting)}
        onCancel={() => setDeleting(null)}
      />
    </section>
  );
}

// "Invite a user": username + display name + role — deliberately NO password
// field. Submitting returns the one-time link, handed to InviteLinkModal.
function CreateUserModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (invite: {
    username: string;
    url: string;
    expiresAt: string;
  }) => Promise<void>;
}) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<UserRole>("editor");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetchJson<{
        user: { username: string };
        invite: { token: string; expiresAt: string };
      }>("/api/auth/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username,
          displayName: displayName.trim() || undefined,
          role,
        }),
      });
      await onCreated({
        username: r.user.username,
        url: `${window.location.origin}/invite/${r.invite.token}`,
        expiresAt: r.invite.expiresAt,
      });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Invite a user"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h2 className="modal-title">Invite a user</h2>
        <p className="hint">
          No password to type here: you&apos;ll get a one-time link to send them
          — they choose their own password when they open it.
        </p>

        <label className="modal-label" htmlFor="uf-username">
          Username
        </label>
        <input
          id="uf-username"
          className="input"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
          minLength={3}
          maxLength={32}
          required
        />
        <label className="modal-label" htmlFor="uf-display">
          Display name <span className="hint">(optional)</span>
        </label>
        <input
          id="uf-display"
          className="input"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />

        <label className="modal-label" htmlFor="uf-role">
          Role
        </label>
        <select
          id="uf-role"
          className="select"
          value={role}
          onChange={(e) => setRole(e.target.value as UserRole)}
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r} — {ROLE_HINT[r]}
            </option>
          ))}
        </select>

        {error && <div className="error-box">{error}</div>}

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "…" : "Create & get link"}
          </button>
        </div>
      </form>
    </div>
  );
}

// Shows a freshly issued invite link — the ONLY time the clear token is
// visible (the server stores just its hash). Copy it now or re-issue later.
function InviteLinkModal({
  invite,
  onClose,
}: {
  invite: { username: string; url: string; expiresAt: string };
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(invite.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable (plain-http on the LAN…): select the text
      // so a manual Ctrl/Cmd-C still works.
      inputRef.current?.select();
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Invite link for ${invite.username}`}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title">Invite link — @{invite.username}</h2>
        <p className="hint">
          Send this link to them over a channel you trust. It is shown only
          once, works once, and expires {fmtDate(invite.expiresAt)}. If it
          lapses, issue a new one from the table.
        </p>

        <div className="invite-link-row">
          <input
            ref={inputRef}
            className="input invite-link-input"
            readOnly
            value={invite.url}
            onFocus={(e) => e.currentTarget.select()}
            aria-label="Invite link"
          />
          <button type="button" className="btn" onClick={copy}>
            {copied ? "Copied ✓" : "Copy"}
          </button>
        </div>

        <div className="modal-actions">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
