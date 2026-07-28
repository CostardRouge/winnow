"use client";

// Client half of the invite screen: validates the token (who is this link
// for?), then lets the person choose their password — set + burned + signed in
// by one POST. An unknown/expired/already-used token gets a dead-end message
// pointing back to the admin, never a form.
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Brand } from "../../ui";

type State =
  | { step: "loading" }
  | { step: "dead"; message: string }
  | { step: "form"; username: string; displayName: string | null };

export default function InviteForm({ token }: { token: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ step: "loading" });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/auth/invite/${encodeURIComponent(token)}`)
      .then(async (r) => {
        const data = await r.json().catch(() => null);
        if (!alive) return;
        if (r.ok && data?.invite) {
          setState({
            step: "form",
            username: data.invite.username,
            displayName: data.invite.displayName ?? null,
          });
        } else {
          setState({
            step: "dead",
            message:
              (data && typeof data.error === "string" && data.error) ||
              "This invite link is invalid or has expired",
          });
        }
      })
      .catch(() => {
        if (alive)
          setState({ step: "dead", message: "Network error — is the server reachable?" });
      });
    return () => {
      alive = false;
    };
  }, [token]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || state.step !== "form") return;
    setError(null);
    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }
    setBusy(true);
    try {
      const r = await fetch(`/api/auth/invite/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) {
        setError(
          (data && typeof data.error === "string" && data.error) ||
            `Something went wrong (HTTP ${r.status})`,
        );
        return;
      }
      router.replace("/library");
      router.refresh();
    } catch {
      setError("Network error — is the server reachable?");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <Brand />
        </div>

        {state.step === "loading" && <p className="login-sub">Checking your invite…</p>}

        {state.step === "dead" && (
          <>
            <h1 className="login-title">Invite not valid</h1>
            <p className="login-sub">
              {state.message}. Invite links are single-use and expire after a
              few days — ask the person who invited you to send a fresh one.
            </p>
          </>
        )}

        {state.step === "form" && (
          <>
            <h1 className="login-title">
              Welcome{state.displayName ? `, ${state.displayName}` : ""}
            </h1>
            <p className="login-sub">
              Your account <strong>@{state.username}</strong> is ready — choose
              your password to start using the library. Only you will know it.
            </p>

            <label className="login-label" htmlFor="invite-password">
              Password
            </label>
            <input
              id="invite-password"
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
              autoFocus
            />

            <label className="login-label" htmlFor="invite-confirm">
              Confirm password
            </label>
            <input
              id="invite-confirm"
              className="input"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
            />

            {error && <div className="login-error">{error}</div>}

            <button className="btn btn-primary login-submit" type="submit" disabled={busy}>
              {busy ? "…" : "Set password & sign in"}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
