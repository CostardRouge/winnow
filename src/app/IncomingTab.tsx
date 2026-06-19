"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { fetchJson } from "@/lib/fetchJson";
import GalleryShell from "./gallery/GalleryShell";
import { SkeletonCards, EmptyState, Icons } from "./ui";

// Onglet Incoming : tout ce qui est à trier (dossiers source/inbox du NAS).
//  - vue "Sessions" : file de travail (compteurs + actions : ignorer, marquer
//    terminé, exporter les picks vers C1) + barre d'indexation d'un chemin ;
//  - vue "Browse"   : exploration galerie scoppée à l'incoming (par dossier,
//    appareil, date), pour parcourir transversalement.

type SessionRow = {
  id: number;
  name: string;
  source_path: string;
  device_hint: string | null;
  asset_count: number;
  captured_at_min: string | null;
  captured_at_max: string | null;
  ignored: boolean;
  completed: boolean;
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

export default function IncomingTab() {
  const [view, setView] = useState<"sessions" | "browse">("sessions");
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanPath, setScanPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchJson<{ sessions?: SessionRow[] }>(
        "/api/sessions?kind=incoming",
      );
      setSessions(data.sessions ?? []);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (view !== "sessions") return;
    load();
    const t = setInterval(load, 5000); // suit l'avancement des dérivés
    return () => clearInterval(t);
  }, [load, view]);

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

  async function toggleComplete(s: SessionRow) {
    await fetch(`/api/sessions/${s.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ completed: !s.completed }),
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
    <div className="tab-pane">
      <div className="subtabs">
        <button
          className={`chip${view === "sessions" ? " active" : ""}`}
          onClick={() => setView("sessions")}
        >
          Sessions
        </button>
        <button
          className={`chip${view === "browse" ? " active" : ""}`}
          onClick={() => setView("browse")}
        >
          Browse
        </button>
      </div>

      {view === "browse" ? (
        <GalleryShell scope="incoming" />
      ) : (
        <div className="sessions-pane">
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

          {error && (
            <div className="error-box">
              <span>Couldn’t refresh sessions: {error}</span>
              <button className="btn" onClick={load}>
                Retry
              </button>
            </div>
          )}
          {loading ? (
            <SkeletonCards rows={5} />
          ) : sessions.length === 0 ? (
            <EmptyState
              icon={Icons.inbox}
              title="No incoming sessions yet"
              hint="Enter a NAS folder path above and start a scan to populate the triage queue."
            />
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
                      {s.completed && <span className="pill done">✓ done</span>}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button className="btn" onClick={() => toggleComplete(s)}>
                      {s.completed ? "Unmark" : "Mark complete"}
                    </button>
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
      )}
    </div>
  );
}
