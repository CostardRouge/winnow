"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { fetchJson } from "@/lib/fetchJson";
import GalleryShell from "./gallery/GalleryShell";
import { SkeletonCards, EmptyState, Icons, LazyImage } from "./ui";

// Incoming tab: everything to cull (source/inbox folders on the NAS).
//  - "Sessions" view: work queue (counters + actions: ignore, mark
//    done, export picks to C1) + indexing bar for a path;
//  - "Browse"   view: gallery exploration scoped to the incoming (by folder,
//    device, date), to browse across.
//
// The session queue itself renders in one of two layouts (persisted): a "list"
// (one row each, with a 3-up thumbnail strip) or a "card" grid (a stacked deck
// of thumbnails per session — 2 per row on mobile, 4+ on desktop). Either way
// the thumbnails load on sight via LazyImage's IntersectionObserver.

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
  sample_asset_ids: number[];
};

type Layout = "list" | "card";
const LAYOUT_KEY = "winnow.sessions.layout";

function fmtDate(s: string | null): string {
  if (!s) return "—";
  try {
    return new Date(s).toLocaleDateString("en-GB");
  } catch {
    return s;
  }
}

function SessionMeta({ s }: { s: SessionRow }) {
  return (
    <div className="meta">
      {s.device_hint ?? "device ?"} · {fmtDate(s.captured_at_min)}
      {" → "}
      {fmtDate(s.captured_at_max)} · {s.asset_count} files
    </div>
  );
}

function SessionCounters({ s }: { s: SessionRow }) {
  return (
    <div className="counters">
      <span className="pill ready">{s.ready_count} ready</span>
      <span className="pill pending">{s.pending_count} pending</span>
      {s.error_count > 0 && (
        <span className="pill error">{s.error_count} errors</span>
      )}
      <span className="pill picks">{s.pick_count} picks</span>
      {s.completed && <span className="pill done">✓ done</span>}
    </div>
  );
}

// A few thumbnails in a row (list layout) to hint at the session's content.
function ThumbStrip({ ids }: { ids: number[] }) {
  const shown = (ids ?? []).slice(0, 3);
  if (shown.length === 0) return null;
  return (
    <div className="thumb-strip">
      {shown.map((id) => (
        <LazyImage key={id} src={`/api/assets/${id}/thumb`} alt="" />
      ))}
    </div>
  );
}

// An overlapping "deck" of a few thumbnails (card layout): front-most first.
function ThumbStack({ ids }: { ids: number[] }) {
  const shown = (ids ?? []).slice(0, 3);
  if (shown.length === 0) {
    return <div className="thumb-stack is-empty">No preview yet</div>;
  }
  return (
    <div className="thumb-stack">
      {shown.map((id, i) => {
        const depth = shown.length - 1 - i; // 0 = front-most card
        return (
          <LazyImage
            key={id}
            className="thumb-stack-item"
            src={`/api/assets/${id}/thumb`}
            alt=""
            style={{
              zIndex: shown.length - depth,
              transform: `translate(${depth * 8}px, ${depth * 8}px) scale(${1 - depth * 0.04})`,
              opacity: 1 - depth * 0.12,
            }}
          />
        );
      })}
    </div>
  );
}

export default function IncomingTab() {
  const [view, setView] = useState<"sessions" | "browse">("sessions");
  const [layout, setLayout] = useState<Layout>("list");
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanPath, setScanPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Restore / persist the layout choice (client-only to avoid SSR mismatch).
  useEffect(() => {
    const saved = localStorage.getItem(LAYOUT_KEY);
    if (saved === "list" || saved === "card") setLayout(saved);
  }, []);
  useEffect(() => {
    localStorage.setItem(LAYOUT_KEY, layout);
  }, [layout]);

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
    const t = setInterval(load, 5000); // follows the derivatives' progress
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

  function sessionActions(s: SessionRow) {
    return (
      <div className="session-actions">
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
            <div className="layout-toggle" role="group" aria-label="Session layout">
              <button
                className={`layout-btn${layout === "list" ? " active" : ""}`}
                onClick={() => setLayout("list")}
                aria-pressed={layout === "list"}
                title="List view"
              >
                {Icons.viewList}
              </button>
              <button
                className={`layout-btn${layout === "card" ? " active" : ""}`}
                onClick={() => setLayout("card")}
                aria-pressed={layout === "card"}
                title="Card view"
              >
                {Icons.viewCard}
              </button>
            </div>
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
          ) : layout === "card" ? (
            <div className="session-list as-cards">
              {sessions.map((s) => (
                <div
                  key={s.id}
                  className={`session-card as-card${s.ignored ? " ignored" : ""}`}
                >
                  <Link href={`/sessions/${s.id}`} className="session-preview">
                    <ThumbStack ids={s.sample_asset_ids} />
                  </Link>
                  <div className="session-card-body">
                    <h3>
                      <Link href={`/sessions/${s.id}`}>{s.name}</Link>
                    </h3>
                    <SessionMeta s={s} />
                    <SessionCounters s={s} />
                  </div>
                  {sessionActions(s)}
                </div>
              ))}
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
                    <SessionMeta s={s} />
                    <div style={{ marginTop: 8 }}>
                      <SessionCounters s={s} />
                    </div>
                    <ThumbStrip ids={s.sample_asset_ids} />
                  </div>
                  {sessionActions(s)}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
