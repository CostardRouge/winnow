"use client";

// User management table (admin-only page): create accounts, change roles,
// enable/disable, reset passwords, delete. The server enforces the invariants
// (last-active-admin protection, no self-delete) — the UI just surfaces them.
import { useCallback, useEffect, useState, type FormEvent } from "react";
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
  const [resetting, setResetting] = useState<UserItem | null>(null);
  const [deleting, setDeleting] = useState<UserItem | null>(null);

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

  if (loading) return <LoadingState label="Loading users…" />;

  return (
    <section>
      {error && <div className="error-box">{error}</div>}

      <div className="filterbar" style={{ justifyContent: "flex-end" }}>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          + Add user
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
                  <td>{u.disabled ? "disabled" : "active"}</td>
                  <td>
                    <div className="vol-actions">
                      <button
                        className="btn btn-sm"
                        disabled={busyId === u.id}
                        onClick={() => setResetting(u)}
                      >
                        Reset password
                      </button>
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
        <UserFormModal
          title="Add a user"
          submitLabel="Create user"
          withRole
          onClose={() => setCreating(false)}
          onSubmit={async (v) => {
            await fetchJson("/api/auth/users", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(v),
            });
            setCreating(false);
            await load();
          }}
        />
      )}

      {resetting && (
        <UserFormModal
          title={`Reset password — @${resetting.username}`}
          submitLabel="Set new password"
          passwordOnly
          onClose={() => setResetting(null)}
          onSubmit={async (v) => {
            await fetchJson(`/api/auth/users/${resetting.id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ password: v.password }),
            });
            setResetting(null);
          }}
        />
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

// Shared modal for "create user" and "reset password": a few fields + inline
// error, styled with the app's modal classes.
function UserFormModal({
  title,
  submitLabel,
  withRole = false,
  passwordOnly = false,
  onClose,
  onSubmit,
}: {
  title: string;
  submitLabel: string;
  withRole?: boolean;
  passwordOnly?: boolean;
  onClose: () => void;
  onSubmit: (v: {
    username: string;
    displayName?: string;
    password: string;
    role: UserRole;
  }) => Promise<void>;
}) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRole>("editor");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        username,
        displayName: displayName.trim() || undefined,
        password,
        role,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h2 className="modal-title">{title}</h2>

        {!passwordOnly && (
          <>
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
          </>
        )}

        <label className="modal-label" htmlFor="uf-password">
          {passwordOnly ? "New password" : "Password"}
        </label>
        <input
          id="uf-password"
          className="input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          minLength={8}
          required
        />

        {withRole && (
          <>
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
          </>
        )}

        {error && <div className="error-box">{error}</div>}

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "…" : submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
