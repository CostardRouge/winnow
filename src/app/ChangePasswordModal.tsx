"use client";

// Self-service "change my password" (account popover → Change password).
// Always re-proves the current password — a walked-away-from browser must not
// be enough — and on success the server revokes every OTHER session of the
// account while keeping this browser signed in on a fresh cookie
// (cf. PATCH /api/auth/me).
import { useState, type FormEvent } from "react";

export default function ChangePasswordModal({
  onClose,
}: {
  onClose: () => void;
}) {
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/auth/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, currentPassword: current }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) {
        setError(
          (data && typeof data.error === "string" && data.error) ||
            `Something went wrong (HTTP ${r.status})`,
        );
        return;
      }
      setDone(true);
    } catch {
      setError("Network error — is the server reachable?");
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
        aria-label="Change password"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h2 className="modal-title">Change password</h2>

        {done ? (
          <>
            <p className="hint">
              Password changed. Any other device that was signed in has been
              signed out; this browser stays in.
            </p>
            <div className="modal-actions">
              <button type="button" className="btn btn-primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <label className="modal-label" htmlFor="cp-current">
              Current password
            </label>
            <input
              id="cp-current"
              className="input"
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
              required
              autoFocus
            />

            <label className="modal-label" htmlFor="cp-new">
              New password
            </label>
            <input
              id="cp-new"
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
            />

            <label className="modal-label" htmlFor="cp-confirm">
              Confirm new password
            </label>
            <input
              id="cp-confirm"
              className="input"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
            />

            {error && <div className="error-box">{error}</div>}

            <div className="modal-actions">
              <button type="button" className="btn" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? "…" : "Change password"}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
