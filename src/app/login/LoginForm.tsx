"use client";

// Sign-in / first-run form. Two modes on one screen, decided by the server:
//   * setup  (no account exists yet): create the first admin, signed in on the
//     spot — so a fresh install never needs a CLI detour;
//   * login  (normal life): username + password → session cookie, then back to
//     the page the visit was headed to (?next=, path-only).
import { useEffect, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Brand } from "../ui";

type Mode = "loading" | "login" | "setup";

// Only ever navigate inside the app: a same-site path, never a full URL.
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/library";
  return raw;
}

export default function LoginForm() {
  const router = useRouter();
  const next = safeNext(useSearchParams().get("next"));

  const [mode, setMode] = useState<Mode>("loading");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/auth/setup")
      .then((r) => r.json())
      .then((d) => {
        if (alive) setMode(d?.setupNeeded ? "setup" : "login");
      })
      .catch(() => {
        if (alive) setMode("login");
      });
    return () => {
      alive = false;
    };
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || mode === "loading") return;
    setError(null);
    if (mode === "setup" && password !== confirm) {
      setError("Passwords do not match");
      return;
    }
    setBusy(true);
    try {
      const url = mode === "setup" ? "/api/auth/setup" : "/api/auth/login";
      const body =
        mode === "setup"
          ? { username, password, displayName: displayName || undefined }
          : { username, password };
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) {
        setError(
          (data && typeof data.error === "string" && data.error) ||
            `Sign-in failed (HTTP ${r.status})`,
        );
        return;
      }
      router.replace(next);
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
        {mode === "setup" ? (
          <>
            <h1 className="login-title">Welcome</h1>
            <p className="login-sub">
              No account exists yet — create the administrator to get started.
            </p>
          </>
        ) : (
          <>
            <h1 className="login-title">Sign in</h1>
            <p className="login-sub">Your shared library, your own account.</p>
          </>
        )}

        <label className="login-label" htmlFor="login-username">
          Username
        </label>
        <input
          id="login-username"
          className="input"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          required
          disabled={mode === "loading"}
        />

        {mode === "setup" && (
          <>
            <label className="login-label" htmlFor="login-display">
              Display name <span className="hint">(optional)</span>
            </label>
            <input
              id="login-display"
              className="input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              autoComplete="name"
            />
          </>
        )}

        <label className="login-label" htmlFor="login-password">
          Password
        </label>
        <input
          id="login-password"
          className="input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === "setup" ? "new-password" : "current-password"}
          minLength={mode === "setup" ? 8 : undefined}
          required
          disabled={mode === "loading"}
        />

        {mode === "setup" && (
          <>
            <label className="login-label" htmlFor="login-confirm">
              Confirm password
            </label>
            <input
              id="login-confirm"
              className="input"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
            />
          </>
        )}

        {error && <div className="login-error">{error}</div>}

        <button
          className="btn btn-primary login-submit"
          type="submit"
          disabled={busy || mode === "loading"}
        >
          {busy
            ? "…"
            : mode === "setup"
              ? "Create admin & sign in"
              : "Sign in"}
        </button>
      </form>
    </div>
  );
}
