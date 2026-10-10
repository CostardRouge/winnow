"use client";

// App tokens (admin-only page): the keys a client app holds on one person's
// behalf when it cannot hold the session cookie — Atelier launched from a
// phone's home screen runs in a cookie jar of its own, so signing in on
// Winnow's page never reaches it. The app sends the token as
// `Authorization: Bearer` instead.
//
// A token is not an account: it opens its owner's account (same trips, same
// ratings byline), capped — read-only or read & write, never admin, the API
// only, and it cannot mint another (lib/authz.ts). The clear token exists
// client-side in exactly one place, the modal that shows it once; the server
// keeps its SHA-256. Losing it means revoking it and minting another.
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { fetchJson } from "@/lib/fetchJson";
import { formatDay, formatRelativeTime } from "@/lib/format";
import type { TokenRole, UserRole } from "@/lib/authz";
import { ConfirmDialog, EmptyState, Icons, LoadingState, Spinner } from "../../ui";
import { OptionPicker, type PickerOption } from "../../OptionPicker";
import { useOverlayDismiss } from "../../useOverlayDismiss";

type TokenItem = {
  id: number;
  name: string;
  hint: string;
  role: TokenRole;
  agent: boolean;
  effectiveRole: UserRole;
  owner: {
    id: number;
    username: string;
    displayName: string | null;
    disabled: boolean;
  };
  createdBy: string | null;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  expired: boolean;
};

type Account = {
  id: number;
  username: string;
  displayName: string | null;
  role: UserRole;
  disabled: boolean;
};

const ACCESS: PickerOption<TokenRole>[] = [
  {
    key: "viewer",
    label: "Read only",
    hint: "Browse, stream, download, and keep the app’s own documents",
  },
  {
    key: "editor",
    label: "Read & write",
    hint: "Also rate, tag, trash, upload, import and export",
  },
];

// Who holds it. An agent's token is capped exactly like an app's; the only
// difference is that what it writes is stamped as an agent's (migration 0050),
// so a pick Claude made can be told from one made by hand.
type Holder = "app" | "agent";

const HOLDERS: PickerOption<Holder>[] = [
  {
    key: "app",
    label: "An app",
    hint: "A client such as Atelier, acting as the account",
  },
  {
    key: "agent",
    label: "An agent",
    hint: "An MCP client such as Claude — its ratings are marked as an agent’s",
  },
];

const ACCESS_LABEL: Record<UserRole, string> = {
  viewer: "Read only",
  editor: "Read & write",
  admin: "Read & write", // never a token's ceiling; listed for the type
};

type Lifetime = "30" | "90" | "365" | "never";

const LIFETIMES: PickerOption<Lifetime>[] = [
  { key: "30", label: "30 days" },
  { key: "90", label: "90 days" },
  { key: "365", label: "1 year" },
  { key: "never", label: "Never", hint: "Stays valid until revoked" },
];

export default function TokensPanel() {
  const [tokens, setTokens] = useState<TokenItem[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [meId, setMeId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<TokenItem | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [minted, setMinted] = useState<Minted | null>(
    null,
  );

  const load = useCallback(async () => {
    try {
      const [list, users, whoami] = await Promise.all([
        fetchJson<{ tokens: TokenItem[] }>("/api/auth/tokens"),
        fetchJson<{ users: Account[] }>("/api/auth/users"),
        fetchJson<{ user: { id: number } }>("/api/auth/me"),
      ]);
      setTokens(list.tokens);
      setAccounts(users.users);
      setMeId(whoami.user.id);
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

  async function revoke(t: TokenItem) {
    setBusyId(t.id);
    setError(null);
    try {
      await fetchJson(`/api/auth/tokens/${t.id}`, { method: "DELETE" });
      setRevoking(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <LoadingState label="Loading app tokens…" />;

  return (
    <section>
      {error && <div className="error-box">{error}</div>}

      <div className="filterbar" style={{ justifyContent: "flex-end" }}>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          + New token
        </button>
      </div>

      {tokens.length === 0 ? (
        <EmptyState
          icon={Icons.key}
          title="No app tokens"
          hint="A token lets an app that cannot share your browser’s sign-in — Atelier on a phone’s home screen — reach this library as one account."
        />
      ) : (
        <div className="vol-table-wrap">
          {/* users-table: the same phone folding as Accounts (cf. globals.css). */}
          <table className="vol-table users-table">
            <thead>
              <tr>
                <th>Token</th>
                <th>Access</th>
                <th>Last used</th>
                <th>Expires</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => {
                const dead = t.expired || t.owner.disabled;
                return (
                  <tr key={t.id} style={dead ? { opacity: 0.55 } : undefined}>
                    <td>
                      <div className="vol-path">{t.name}</div>
                      <div className="hint">
                        {t.agent ? "agent " : ""}as @{t.owner.username} · ends
                        in <span className="token-hint">{t.hint}</span>
                      </div>
                    </td>
                    <td data-th="Access">
                      {ACCESS_LABEL[t.effectiveRole]}
                      {t.effectiveRole !== t.role && (
                        <div className="hint">
                          capped: @{t.owner.username} is a {t.effectiveRole}
                        </div>
                      )}
                    </td>
                    <td className="num" data-th="Last used">
                      {formatRelativeTime(t.lastUsedAt)}
                    </td>
                    <td data-th="Expires">
                      {t.owner.disabled ? (
                        <>
                          refused
                          <div className="hint">the account is disabled</div>
                        </>
                      ) : t.expired ? (
                        <>
                          expired
                          <div className="hint">{formatDay(t.expiresAt)}</div>
                        </>
                      ) : t.expiresAt ? (
                        formatDay(t.expiresAt)
                      ) : (
                        "never"
                      )}
                    </td>
                    <td>
                      <div className="vol-actions">
                        <button
                          className="btn btn-sm btn-danger"
                          disabled={busyId === t.id}
                          onClick={() => setRevoking(t)}
                        >
                          Revoke
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="hint" style={{ marginTop: 12 }}>
        A token opens its account’s library, trips and ratings, never more than
        that account may do and never admin: no settings, no user management, no
        page — the API only. The app keeps it in its own storage, so treat it
        like a password: one token per device, revoked here when the device is
        lost. Changing the account’s password does not revoke its tokens;
        disabling the account does.
      </p>

      {creating && (
        <CreateTokenModal
          accounts={accounts.filter((a) => !a.disabled)}
          defaultOwner={meId}
          onClose={() => setCreating(false)}
          onCreated={async (m) => {
            setCreating(false);
            setMinted(m);
            await load();
          }}
        />
      )}

      {minted && <SecretModal minted={minted} onClose={() => setMinted(null)} />}

      <ConfirmDialog
        open={revoking != null}
        title="Revoke this token?"
        message={
          <>
            <strong>{revoking?.name}</strong> stops working at once: the app
            holding it gets refused on its next request and will ask for a new
            token. Nothing it did is undone.
          </>
        }
        confirmLabel="Revoke token"
        danger
        busy={busyId === revoking?.id}
        onConfirm={() => revoking && revoke(revoking)}
        onCancel={() => setRevoking(null)}
      />
    </section>
  );
}

function CreateTokenModal({
  accounts,
  defaultOwner,
  onClose,
  onCreated,
}: {
  accounts: Account[];
  defaultOwner: number | null;
  onClose: () => void;
  onCreated: (m: Minted) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [ownerId, setOwnerId] = useState<number | null>(
    accounts.some((a) => a.id === defaultOwner)
      ? defaultOwner
      : (accounts[0]?.id ?? null),
  );
  const [holder, setHolder] = useState<Holder>("app");
  const [access, setAccess] = useState<TokenRole>("viewer");
  const [lifetime, setLifetime] = useState<Lifetime>("365");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const backdrop = useOverlayDismiss<HTMLDivElement>(() => {
    if (!busy) onClose();
  });

  const owner = accounts.find((a) => a.id === ownerId) ?? null;
  // A viewer's token is read-only whatever is asked (the server clamps it);
  // say so before the click rather than after it.
  const capped = owner?.role === "viewer" && access === "editor";

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || ownerId == null) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetchJson<{ token: { name: string }; secret: string }>(
        "/api/auth/tokens",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: ownerId,
            name: name.trim(),
            role: access,
            agent: holder === "agent",
            expiresInDays: lifetime === "never" ? null : Number(lifetime),
          }),
        },
      );
      await onCreated({ name: r.token.name, secret: r.secret, agent: holder === "agent" });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" role="presentation" {...backdrop}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="New app token"
        onSubmit={submit}
      >
        <h2 className="modal-title">New app token</h2>
        <p className="hint">
          For an app that cannot use this browser’s sign-in, or an agent. It
          acts as the account you pick, within the access you give it.
        </p>

        <label className="modal-label" htmlFor="tk-name">
          Name
        </label>
        <input
          id="tk-name"
          className="input modal-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Atelier — iPhone"
          maxLength={80}
          required
        />

        <label className="modal-label" htmlFor="tk-owner">
          Acts as
        </label>
        <select
          id="tk-owner"
          className="select modal-input"
          value={ownerId ?? ""}
          onChange={(e) => setOwnerId(Number(e.target.value))}
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.displayName?.trim() || a.username} — @{a.username} ({a.role})
            </option>
          ))}
        </select>

        <span className="modal-label">Used by</span>
        <OptionPicker
          options={HOLDERS}
          value={holder}
          onChange={setHolder}
          ariaLabel="Used by"
        />
        <p className="hint">{HOLDERS.find((o) => o.key === holder)?.hint}</p>

        <span className="modal-label">Access</span>
        <OptionPicker
          options={ACCESS}
          value={access}
          onChange={setAccess}
          ariaLabel="Access"
        />
        <p className="hint">
          {capped
            ? `@${owner?.username} is a viewer, so this token will be read-only.`
            : ACCESS.find((o) => o.key === access)?.hint}
        </p>

        <span className="modal-label">Expires after</span>
        <OptionPicker
          options={LIFETIMES}
          value={lifetime}
          onChange={setLifetime}
          ariaLabel="Expires after"
        />

        {error && <div className="error-box">{error}</div>}

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || ownerId == null || !name.trim()}
          >
            {busy ? <Spinner sm /> : "Create token"}
          </button>
        </div>
      </form>
    </div>
  );
}

type Minted = { name: string; secret: string; agent: boolean };

// The line that registers the MCP server (src/scripts/mcp.ts) with Claude
// Code, user scope so it is not committed with a project's .mcp.json. The
// server is a client of this API run from a checkout, hence the path.
function claudeMcpAdd(origin: string, secret: string): string {
  return `claude mcp add winnow --scope user -e WINNOW_HOST=${origin} -e WINNOW_TOKEN=${secret} -- ~/winnow/node_modules/.bin/tsx ~/winnow/src/scripts/mcp.ts`;
}

// The ONE time the clear token is visible. The instance address rides along
// because the app's connect screen asks for both.
function SecretModal({
  minted,
  onClose,
}: {
  minted: Minted;
  onClose: () => void;
}) {
  const backdrop = useOverlayDismiss<HTMLDivElement>(onClose);
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  return (
    <div className="modal-overlay" role="presentation" {...backdrop}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Token for ${minted.name}`}
      >
        <h2 className="modal-title">{minted.name}</h2>
        <p className="hint">
          {minted.agent
            ? "Give it to the agent now"
            : "Paste it into the app’s token field now"}
          : it is shown only once, and Winnow keeps no copy it could show you
          again. Lost it? Revoke it and create another.
        </p>

        <CopyRow label="Token" value={minted.secret} />
        <CopyRow label="Winnow address" value={origin} />
        {minted.agent && (
          <>
            <CopyRow
              label="Claude Code"
              value={claudeMcpAdd(origin, minted.secret)}
            />
            <p className="hint">
              Run it where your Winnow checkout is (after{" "}
              <code>npm install</code>), with <code>~/winnow</code> replaced by
              its path. The token is then kept in your Claude Code settings on
              that machine — README › “Driving Winnow from Claude”.
            </p>
          </>
        )}

        <div className="modal-actions">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // No Clipboard API (plain http on the LAN…): select it so a manual
      // Ctrl/Cmd-C still works.
      inputRef.current?.select();
    }
  }

  return (
    <>
      <span className="modal-label">{label}</span>
      <div className="invite-link-row">
        <input
          ref={inputRef}
          className="input invite-link-input"
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          aria-label={label}
        />
        <button type="button" className="btn" onClick={copy}>
          {copied ? "Copied ✓" : "Copy"}
        </button>
      </div>
    </>
  );
}
