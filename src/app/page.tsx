"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type SessionRow = {
  id: number;
  name: string;
  source_path: string;
  device_hint: string | null;
  asset_count: number;
  captured_at_min: string | null;
  captured_at_max: string | null;
  ignored: boolean;
  ready_count: number;
  pending_count: number;
  error_count: number;
  pick_count: number;
};

function fmtDate(s: string | null): string {
  if (!s) return "—";
  try {
    return new Date(s).toLocaleDateString("en-GB");
  } catch {
    return s;
  }
}

export default function Dashboard() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanPath, setScanPath] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/sessions");
    const data = await r.json();
    setSessions(data.sessions ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000); // suit l'avancement des dérivés
    return () => clearInterval(t);
  }, [load]);

  async function startScan() {
    if (!scanPath.trim()) return;
    setBusy(true);
    try {
      await fetch("/api/index/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: scanPath.trim() }),
      });
      setScanPath("");
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function toggleIgnore(s: SessionRow) {
    await fetch(`/api/sessions/${s.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ignored: !s.ignored }),
    });
    await load();
  }

  async function exportPicks(s: SessionRow) {
    const name = prompt(
      "Export name (RAW copy of picks to the C1 export folder):",
      `${s.name}-picks`,
    );
    if (!name) return;
    const r = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        target: "capture_one",
        filter: { session_id: s.id, verdict: "pick" },
      }),
    });
    const data = await r.json();
    alert(
      data.export_job_id
        ? `Export #${data.export_job_id} queued. Run the worker to copy the RAW files.`
        : `Error: ${data.error ?? "unknown"}`,
    );
  }

  return (
    <>
      <div className="topbar">
        <h1>🪶 Winnow</h1>
        <span className="hint">media triage — NAS</span>
        <span className="spacer" />
        <Link href="/import" className="btn">
          + Import
        </Link>
      </div>
      <div className="container">
        <div className="filterbar">
          <input
            className="input"
            style={{ flex: 1, minWidth: 220 }}
            placeholder="/path/to/NAS/folder to index"
            value={scanPath}
            onChange={(e) => setScanPath(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && startScan()}
          />
          <button className="btn btn-primary" onClick={startScan} disabled={busy}>
            {busy ? "…" : "Index"}
          </button>
        </div>

        {loading ? (
          <div className="spinner">Loading…</div>
        ) : sessions.length === 0 ? (
          <div className="empty">
            No sessions indexed yet. Enter a NAS path above to start a scan.
          </div>
        ) : (
          <div className="session-list">
            {sessions.map((s) => (
              <div
                key={s.id}
                className={`session-card${s.ignored ? " ignored" : ""}`}
              >
                <div style={{ flex: 1, minWidth: 200 }}>
                  <h3>
                    <Link href={`/sessions/${s.id}`}>{s.name}</Link>
                  </h3>
                  <div className="meta">
                    {s.device_hint ?? "device ?"} · {fmtDate(s.captured_at_min)}
                    {" → "}
                    {fmtDate(s.captured_at_max)} · {s.asset_count} files
                  </div>
                  <div className="counters" style={{ marginTop: 8 }}>
                    <span className="pill ready">{s.ready_count} ready</span>
                    <span className="pill pending">
                      {s.pending_count} pending
                    </span>
                    {s.error_count > 0 && (
                      <span className="pill error">{s.error_count} errors</span>
                    )}
                    <span className="pill picks">{s.pick_count} picks</span>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button className="btn" onClick={() => toggleIgnore(s)}>
                    {s.ignored ? "Reactivate" : "Ignore"}
                  </button>
                  <button
                    className="btn"
                    onClick={() => exportPicks(s)}
                    disabled={s.pick_count === 0}
                  >
                    Export picks → C1
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
