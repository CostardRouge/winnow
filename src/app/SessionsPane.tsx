"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { fetchJson } from "@/lib/fetchJson";
import { sessionDownloadFiles } from "@/lib/assetActions";
import { SkeletonCards, EmptyState, Icons, LazyImage } from "./ui";
import DeleteSessionModal from "./sessions/DeleteSessionModal";
import SessionActions from "./sessions/SessionActions";
import SessionProgress from "./sessions/SessionProgress";
import ThumbStrip, { type StripItem } from "./ThumbStrip";
import PullToRefresh from "./PullToRefresh";

// The incoming "Sessions" view: the work queue of scanned NAS folders.
//  - counters + actions per session (ignore, mark done, export picks to C1);
//  - an indexing bar to scan a new path into the queue.
//
// Renders in one of two layouts (chosen from the section toolbar): a "list"
// (one row each, with a 3-up thumbnail strip) or a "card" grid (a stacked deck
// of thumbnails per session). Thumbnails load on sight via LazyImage.

export type Layout = "list" | "card";
export type SortDir = "desc" | "asc";

// A ready thumbnail previewing the session, carrying enough to badge the tile
// (extension + a play badge for videos) in the shared strip.
type SampleAsset = {
  id: number;
  ext: string;
  media_type: "photo" | "video";
};

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
  reject_count: number;
  unrated_count: number;
  last_reviewed_at: string | null;
  sample_assets: SampleAsset[];
};

// Picks + rejects vs the whole session (picks + rejects + unrated): every asset
// falls in exactly one bucket, so the three counts sum to the cullable total.
function triageTotal(s: SessionRow): number {
  return Number(s.pick_count) + Number(s.reject_count) + Number(s.unrated_count);
}

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

// Map a session's sample assets onto the shared strip's tile shape — ready
// thumbnails badged with their extension / media type; the strip advertises the
// session's full file count.
function sessionStripItems(samples: SampleAsset[]): StripItem[] {
  return (samples ?? []).map((a) => ({
    key: a.id,
    thumbSrc: `/api/assets/${a.id}/thumb`,
    ext: a.ext,
    isVideo: a.media_type === "video",
  }));
}

// An overlapping "deck" of a few thumbnails (card layout): front-most first.
function ThumbStack({ samples }: { samples: SampleAsset[] }) {
  const shown = (samples ?? []).slice(0, 3).map((a) => a.id);
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

export default function SessionsPane({
  layout,
  query = "kind=incoming",
  sortDir = "desc",
  progress = "",
}: {
  layout: Layout;
  /** Scope + active filters (from the shared Filters/Browse panel). */
  query?: string;
  sortDir?: SortDir;
  /** Triage-progress filter: ""·untouched·partial·incomplete·complete. */
  progress?: string;
}) {
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Session pending a delete confirmation (opens the modal); transient toast.
  const [confirming, setConfirming] = useState<SessionRow | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchJson<{ sessions?: SessionRow[] }>(
        `/api/sessions?${query}&sort_dir=${sortDir}${progress ? `&progress=${progress}` : ""}`,
      );
      setSessions(data.sessions ?? []);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [query, sortDir, progress]);

  // Reload (and show the skeleton) whenever the filters/sort change.
  useEffect(() => {
    setLoading(true);
  }, [query, sortDir, progress]);

  // Polls while mounted (i.e. while this view is active) to follow the
  // derivatives' progress.
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  // Auto-clear the transient confirmation toast.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

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
      <SessionActions
        completed={s.completed}
        ignored={s.ignored}
        canExport={s.pick_count > 0}
        onComplete={() => toggleComplete(s)}
        onIgnore={() => toggleIgnore(s)}
        onExportPicks={() => exportPicks(s)}
        onDelete={() => setConfirming(s)}
        download={{
          zipHref: `/api/sessions/${s.id}/download`,
          zipName: `${s.name}.zip`,
          listFiles: () => sessionDownloadFiles(s.id),
          onMessage: setNotice,
        }}
      />
    );
  }

  async function deleteSession(s: SessionRow, withFiles: boolean) {
    const r = await fetch(
      `/api/sessions/${s.id}${withFiles ? "?files=true" : ""}`,
      { method: "DELETE" },
    );
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error ?? "Couldn’t delete this session.");
    setSessions((prev) => prev.filter((x) => x.id !== s.id));
    const d = data.deleted ?? {};
    setNotice(
      withFiles
        ? `Deleted “${s.name}” · ${d.files_deleted ?? 0} file(s) removed from disk`
        : `Deleted “${s.name}” from the database`,
    );
    if (d.file_errors?.length) {
      setNotice(
        `Deleted “${s.name}”, but ${d.file_errors.length} file(s) couldn’t be removed.`,
      );
    }
  }

  return (
    <PullToRefresh className="sessions-pane" onRefresh={load}>
      {notice && (
        <div style={{ marginBottom: 12 }}>
          <span className="notice">{notice}</span>
        </div>
      )}
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
          hint="Add a NAS folder in Volumes and start a scan to populate the triage queue."
        >
          <Link href="/volumes" className="btn btn-primary">
            {Icons.folderPlus} Add folder
          </Link>
        </EmptyState>
      ) : layout === "card" ? (
        <div className="session-list as-cards">
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`session-card as-card${s.ignored ? " ignored" : ""}`}
            >
              <Link href={`/sessions/${s.id}`} className="session-preview">
                <ThumbStack samples={s.sample_assets} />
              </Link>
              <div className="session-card-body">
                <h3>
                  <Link href={`/sessions/${s.id}`}>{s.name}</Link>
                </h3>
                <SessionMeta s={s} />
                <SessionCounters s={s} />
                <SessionProgress
                  picks={Number(s.pick_count)}
                  rejects={Number(s.reject_count)}
                  total={triageTotal(s)}
                  compact
                />
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
              className={`session-card is-stacked${s.ignored ? " ignored" : ""}`}
            >
              <div className="card-head">
                <div className="card-info">
                  <h3>
                    <Link href={`/sessions/${s.id}`}>{s.name}</Link>
                  </h3>
                  <SessionMeta s={s} />
                </div>
                <div className="card-side">
                  {sessionActions(s)}
                  <SessionCounters s={s} />
                </div>
              </div>
              <ThumbStrip
                items={sessionStripItems(s.sample_assets)}
                total={s.asset_count}
                onItemActivate={() => router.push(`/sessions/${s.id}`)}
                onOverflowActivate={() => router.push(`/sessions/${s.id}`)}
              />
              <SessionProgress
                picks={Number(s.pick_count)}
                rejects={Number(s.reject_count)}
                total={triageTotal(s)}
                compact
                className="is-footer"
              />
            </div>
          ))}
        </div>
      )}

      {confirming && (
        <DeleteSessionModal
          session={confirming}
          onClose={() => setConfirming(null)}
          onConfirm={async (withFiles) => {
            await deleteSession(confirming, withFiles);
            setConfirming(null);
          }}
        />
      )}
    </PullToRefresh>
  );
}
