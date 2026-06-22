"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  use as usePromise,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { fetchJson } from "@/lib/fetchJson";
import AssetActionMenu, {
  type AssetMenuAction,
} from "@/app/gallery/AssetActionMenu";
import MediaViewer from "@/app/MediaViewer";
import ViewerActions from "@/app/ViewerActions";
import DeleteSessionModal from "@/app/sessions/DeleteSessionModal";
import SessionActions from "@/app/sessions/SessionActions";
import PullToRefresh from "@/app/PullToRefresh";
import { Icons } from "@/app/ui";
import { formatBadge } from "@/lib/format";
import {
  deleteAssets,
  downloadAssetOriginal,
  exportAssets,
  regenerateAssets,
  sessionDownloadFiles,
  tagAssets,
} from "@/lib/assetActions";

type Verdict = "pick" | "reject" | "unrated";
type AssetRow = {
  id: number;
  filename: string;
  ext: string;
  media_type: "photo" | "video";
  derivative_status: string;
  captured_at: string | null;
  file_mtime: string | null;
  file_size: number | null;
  camera_model: string | null;
  lens: string | null;
  iso: number | null;
  shutter: string | null;
  aperture: number | null;
  focal_length: number | null;
  width: number | null;
  height: number | null;
  duration_s: number | null;
  device: string | null;
  gps: { lat: number; lon: number } | null;
  rel_path: string | null;
  verdict: Verdict;
  star: number;
  // Pairing (cf. lib/pairing.ts): the companion of this displayed primary, its
  // group kind and the companion's per-file stats. Feed the grid badge and the
  // viewer's segmented light↔RAW toggle; NULL when the asset isn't paired.
  companion_id?: number | null;
  companion_ext?: string | null;
  companion_media_type?: "photo" | "video" | null;
  companion_filename?: string | null;
  companion_file_size?: number | null;
  companion_width?: number | null;
  companion_height?: number | null;
  group_kind?: "raw_jpeg" | "live_photo" | null;
};

// Session metadata + status breakdown (GET /api/sessions/:id). Postgres returns
// the COUNT(*) columns as strings, so the header coerces them with Number().
type SessionInfo = {
  id: number;
  name: string;
  source_path: string;
  device_hint: string | null;
  captured_at_min: string | null;
  captured_at_max: string | null;
  asset_count: number;
  ignored: boolean;
  completed: boolean;
  root_kind: "source" | "finals" | "inbox" | "export";
  root_path: string;
  ready_count: number | string;
  pending_count: number | string;
  error_count: number | string;
  live_count: number | string;
  pick_count: number | string;
  reject_count: number | string;
  unrated_count: number | string;
};

const VERDICT_FILTERS: Array<{ key: string; label: string }> = [
  { key: "", label: "All" },
  { key: "unrated", label: "Unrated" },
  { key: "pick", label: "Picks" },
  { key: "reject", label: "Rejects" },
];

function fmtDate(s: string | null): string {
  if (!s) return "—";
  try {
    return new Date(s).toLocaleDateString("en-GB");
  } catch {
    return s;
  }
}

// "incoming" sessions (source/inbox) are cullable; finals are view-only.
function roleLabel(kind: SessionInfo["root_kind"]): string {
  return kind === "finals" ? "final" : kind === "export" ? "export" : "incoming";
}

export default function SessionGrid({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = usePromise(params);
  const router = useRouter();
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [assets, setAssets] = useState<AssetRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verdict, setVerdict] = useState("");
  const [viewer, setViewer] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);

  // Transient confirmation ("Export queued", "Deleted") — auto-clears.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(t);
  }, [notice]);

  // Session header info: load once, then refresh after session-level actions or
  // as the verdict counts drift while culling.
  const loadSession = useCallback(async () => {
    try {
      const data = await fetchJson<{ session: SessionInfo }>(
        `/api/sessions/${id}`,
      );
      setSession(data.session);
    } catch {
      /* header is best-effort; the grid still works without it */
    }
  }, [id]);

  useEffect(() => {
    loadSession();
  }, [loadSession]);

  const reset = useCallback(() => {
    setAssets([]);
    setCursor(null);
    setHasMore(true);
  }, []);

  const fetchPage = useCallback(
    async (cur: string | null) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      setLoading(true);
      try {
        const sp = new URLSearchParams();
        if (cur) sp.set("cursor", cur);
        if (verdict) sp.set("verdict", verdict);
        // collapse=1: a RAW+JPEG (or Live Photo) pair shows as one tile — the
        // lighter direct file (JPEG/HEIF) primary — with its companion riding
        // along on the row for the badge + the viewer's light↔RAW toggle. So
        // prev/next walks pair-by-pair instead of stepping through each file.
        const data = await fetchJson<{
          assets?: AssetRow[];
          next_cursor?: string | null;
        }>(`/api/sessions/${id}/assets?${sp.toString()}&collapse=1`);
        setError(null);
        setAssets((prev) =>
          cur ? [...prev, ...(data.assets ?? [])] : data.assets ?? [],
        );
        setCursor(data.next_cursor ?? null);
        setHasMore(Boolean(data.next_cursor));
      } catch (e) {
        setError((e as Error).message);
        setHasMore(false);
      } finally {
        setLoading(false);
        loadingRef.current = false;
      }
    },
    [id, verdict],
  );

  // Initial (re)load on every filter change.
  useEffect(() => {
    reset();
    fetchPage(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verdict]);

  // Pull-to-refresh: re-pull the header counts and the first page of the grid.
  const refresh = useCallback(async () => {
    reset();
    await Promise.all([loadSession(), fetchPage(null)]);
  }, [reset, loadSession, fetchPage]);

  // Infinite scroll.
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const obs = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && hasMore && !loadingRef.current) {
        fetchPage(cursor);
      }
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [cursor, hasMore, fetchPage]);

  const rate = useCallback(
    async (assetId: number, patch: { verdict?: Verdict; star?: number }) => {
      setAssets((prev) =>
        prev.map((a) => (a.id === assetId ? { ...a, ...patch } : a)),
      );
      await fetch(`/api/assets/${assetId}/rating`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      // Keep the header's verdict counts in step with the grid.
      void loadSession();
    },
    [loadSession],
  );

  // Soft delete (hidden from the library, original untouched). Returns whether
  // it ran (false if the confirm was dismissed).
  const removeAssets = useCallback(
    async (ids: number[]): Promise<boolean> => {
      if (!ids.length) return false;
      const msg =
        ids.length > 1
          ? `Delete ${ids.length} assets? They’ll be hidden from the library — the originals are untouched.`
          : "Delete this asset? It’ll be hidden from the library — the original is untouched.";
      if (!window.confirm(msg)) return false;
      const idset = new Set(ids);
      setAssets((prev) => prev.filter((a) => !idset.has(a.id)));
      await deleteAssets(ids);
      setNotice(ids.length > 1 ? `${ids.length} deleted` : "Deleted");
      void loadSession();
      return true;
    },
    [loadSession],
  );

  const exportSelection = useCallback(async (ids: number[]) => {
    if (!ids.length) return;
    try {
      const jobId = await exportAssets(ids);
      setNotice(`Export queued (#${jobId})`);
    } catch (e) {
      setNotice((e as Error).message);
    }
  }, []);

  // Rebuilds the thumb + proxy. Optimistically flips the cell back to "pending"
  // so the spinner shows until the worker is done.
  const regenerate = useCallback(async (ids: number[]) => {
    if (!ids.length) return;
    const idset = new Set(ids);
    setAssets((prev) =>
      prev.map((a) =>
        idset.has(a.id) ? { ...a, derivative_status: "pending" } : a,
      ),
    );
    try {
      const n = await regenerateAssets(ids);
      setNotice(n > 1 ? `Regenerating ${n} derivatives` : "Regenerating derivative");
    } catch (e) {
      setNotice((e as Error).message);
    }
  }, []);

  const addTag = useCallback(async (id: number, name: string) => {
    if (!name.trim()) return;
    await tagAssets([id], name, true);
    setNotice(`Tagged “${name.trim()}”`);
  }, []);

  // --- Session-level actions (mirror the sessions list) --------------------
  const toggleComplete = useCallback(async () => {
    if (!session) return;
    await fetch(`/api/sessions/${session.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ completed: !session.completed }),
    });
    setNotice(session.completed ? "Marked active" : "Marked complete");
    void loadSession();
  }, [session, loadSession]);

  const toggleIgnore = useCallback(async () => {
    if (!session) return;
    await fetch(`/api/sessions/${session.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ignored: !session.ignored }),
    });
    setNotice(session.ignored ? "Reactivated" : "Ignored");
    void loadSession();
  }, [session, loadSession]);

  const exportPicks = useCallback(async () => {
    if (!session) return;
    const name = prompt(
      "Export name (RAW copy of picks to the C1 export folder):",
      `${session.name}-picks`,
    );
    if (!name) return;
    try {
      const r = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          target: "capture_one",
          filter: { session_id: session.id, verdict: "pick" },
        }),
      });
      const data = await r.json();
      setNotice(
        data.export_job_id
          ? `Export #${data.export_job_id} queued`
          : `Error: ${data.error ?? "unknown"}`,
      );
    } catch (e) {
      setNotice((e as Error).message);
    }
  }, [session]);

  const deleteSession = useCallback(
    async (withFiles: boolean) => {
      if (!session) return;
      const r = await fetch(
        `/api/sessions/${session.id}${withFiles ? "?files=true" : ""}`,
        { method: "DELETE" },
      );
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error ?? "Couldn’t delete this session.");
      router.push("/library/incoming/sessions");
    },
    [session, router],
  );

  // Dispatch a context-menu action onto a single asset.
  const onMenuAction = useCallback(
    (id: number, action: AssetMenuAction) => {
      switch (action.kind) {
        case "verdict":
          return void rate(id, { verdict: action.verdict });
        case "star":
          return void rate(id, { star: action.star });
        case "tag":
          return void addTag(id, action.name);
        case "export":
          return void exportSelection([id]);
        case "download":
          return downloadAssetOriginal(id);
        case "regenerate":
          return void regenerate([id]);
        case "delete":
          return void removeAssets([id]);
      }
    },
    [rate, addTag, exportSelection, regenerate, removeAssets],
  );

  // Keyboard navigation in the viewer (desktop).
  // Rating shortcuts inside the viewer. Escape/arrow navigation is owned by
  // MediaViewer; this only adds the verdict (p/x/u) and star (0–5) keys.
  const onViewerKey = useCallback(
    (e: KeyboardEvent, a: AssetRow) => {
      if (e.key.toLowerCase() === "p") return void rate(a.id, { verdict: "pick" });
      if (e.key.toLowerCase() === "x") return void rate(a.id, { verdict: "reject" });
      if (e.key.toLowerCase() === "u") return void rate(a.id, { verdict: "unrated" });
      if (/^[0-5]$/.test(e.key)) return void rate(a.id, { star: Number.parseInt(e.key, 10) });
    },
    [rate],
  );

  return (
    <>
      <div className="topbar">
        <Link href="/library/incoming/sessions" className="btn btn-icon" aria-label="Back to library">
          {Icons.back}
        </Link>
        <h1>{session?.name ?? `Session #${id}`}</h1>
        <span className="spacer" />
        {notice && <span className="notice">{notice}</span>}
        <span className="hint">{assets.length} loaded</span>
      </div>

      <PullToRefresh className="container" onRefresh={refresh}>
        {session && (
          <SessionHeader
            s={session}
            onComplete={toggleComplete}
            onIgnore={toggleIgnore}
            onExportPicks={exportPicks}
            onDelete={() => setConfirming(true)}
            onMessage={setNotice}
          />
        )}

        <div className="filterbar">
          {VERDICT_FILTERS.map((f) => (
            <button
              key={f.key}
              className={`btn${verdict === f.key ? " btn-primary" : ""}`}
              onClick={() => setVerdict(f.key)}
            >
              {f.label}
            </button>
          ))}
          <span className="spacer" />
          <span className="hint">
            Keyboard: P pick · X reject · U clear · 1-5 stars · ←/→
          </span>
        </div>

        {error && (
          <div className="error-box">
            <span>Couldn’t load assets: {error}</span>
            <button className="btn" onClick={() => fetchPage(null)}>
              Retry
            </button>
          </div>
        )}
        {assets.length === 0 && !loading && !error ? (
          <div className="empty">No assets for this filter.</div>
        ) : (
          <div className="grid">
            {assets.map((a, i) => (
              <div
                key={a.id}
                className={`cell ${a.verdict}`}
                onClick={() => setViewer(i)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, id: a.id });
                }}
              >
                {a.derivative_status === "ready" ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/assets/${a.id}/thumb`}
                    alt={a.filename}
                    loading="lazy"
                  />
                ) : (
                  <div className="placeholder">
                    {a.derivative_status === "error"
                      ? "⚠ error"
                      : a.derivative_status === "skipped"
                        ? a.filename
                        : "⏳ deriving…"}
                  </div>
                )}
                {a.media_type === "video" &&
                  a.derivative_status === "ready" && (
                    <span className="play-badge">▶</span>
                  )}
                {a.verdict !== "unrated" && (
                  <span className="badge">
                    {a.verdict === "pick" ? "✓" : "✕"}
                  </span>
                )}
                {a.star > 0 && (
                  <span className="stars">{"★".repeat(a.star)}</span>
                )}
                <span className={`ext-badge${a.companion_ext ? " paired" : ""}`}>
                  {formatBadge(a.ext, a.companion_ext, a.group_kind)}
                </span>
              </div>
            ))}
          </div>
        )}

        <div ref={sentinel} style={{ height: 40 }} />
        {loading && <div className="spinner">Loading…</div>}
      </PullToRefresh>

      {viewer != null && assets[viewer] && (
        <MediaViewer
          items={assets}
          index={viewer}
          onIndexChange={setViewer}
          onClose={() => setViewer(null)}
          onKeyDown={onViewerKey}
          onContextMenu={(e, a) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, id: a.id });
          }}
          renderActions={(a) => (
            <ViewerActions
              verdict={a.verdict}
              star={a.star}
              onVerdict={(verdict) => rate(a.id, { verdict })}
              onStar={(star) => rate(a.id, { star })}
              onTag={(name) => addTag(a.id, name)}
              onExport={() => exportSelection([a.id])}
              onDownload={() => downloadAssetOriginal(a.id)}
              onRegenerate={() => regenerate([a.id])}
              onDelete={async () => {
                if (await removeAssets([a.id])) {
                  // Keep the viewer open on the previous item rather than
                  // closing it; only bail out if nothing is left.
                  setViewer((cur) => {
                    if (cur == null) return null;
                    const remaining = assets.length - 1;
                    return remaining > 0
                      ? Math.min(Math.max(cur - 1, 0), remaining - 1)
                      : null;
                  });
                }
              }}
            />
          )}
        />
      )}

      {menu && (
        <AssetActionMenu
          x={menu.x}
          y={menu.y}
          label={assets.find((a) => a.id === menu.id)?.filename}
          onAction={(action) => onMenuAction(menu.id, action)}
          onClose={() => setMenu(null)}
        />
      )}

      {confirming && session && (
        <DeleteSessionModal
          session={{
            name: session.name,
            asset_count: session.asset_count,
            pick_count: Number(session.pick_count),
          }}
          onClose={() => setConfirming(false)}
          onConfirm={async (withFiles) => {
            await deleteSession(withFiles);
            setConfirming(false);
          }}
        />
      )}
    </>
  );
}

// Detail header: where the session lives, where it stands (status breakdown +
// triage progress) and the session-level actions found everywhere else.
function SessionHeader({
  s,
  onComplete,
  onIgnore,
  onExportPicks,
  onDelete,
  onMessage,
}: {
  s: SessionInfo;
  onComplete: () => void;
  onIgnore: () => void;
  onExportPicks: () => void;
  onDelete: () => void;
  /** Surface the Download menu's transient status to the page notice. */
  onMessage: (msg: string | null) => void;
}) {
  const total = Number(s.live_count) || 0;
  const ready = Number(s.ready_count) || 0;
  const pending = Number(s.pending_count) || 0;
  const errors = Number(s.error_count) || 0;
  const picks = Number(s.pick_count) || 0;
  const rejects = Number(s.reject_count) || 0;
  const unrated = Number(s.unrated_count) || 0;
  const triaged = picks + rejects;
  const pct = total ? Math.round((triaged / total) * 100) : 0;
  const cullable = s.root_kind === "source" || s.root_kind === "inbox";

  return (
    <section className={`session-detail${s.ignored ? " ignored" : ""}`}>
      <div className="session-detail-top">
        <div className="session-detail-info">
          <div className="session-detail-loc" title={s.source_path}>
            {Icons.folder}
            <span className="session-detail-path">{s.source_path}</span>
            <span className="chip session-detail-kind">{roleLabel(s.root_kind)}</span>
            {s.completed && <span className="pill done">✓ done</span>}
            {s.ignored && <span className="pill">ignored</span>}
          </div>
          <div className="session-detail-meta">
            {(s.device_hint ?? "device ?") + " · "}
            {fmtDate(s.captured_at_min)} → {fmtDate(s.captured_at_max)}
            {" · "}
            {s.asset_count} files
          </div>
        </div>

        <SessionActions
          completed={s.completed}
          ignored={s.ignored}
          canExport={picks > 0}
          onComplete={onComplete}
          onIgnore={onIgnore}
          onExportPicks={onExportPicks}
          onDelete={onDelete}
          download={{
            zipHref: `/api/sessions/${s.id}/download`,
            zipName: `${s.name}.zip`,
            listFiles: () => sessionDownloadFiles(s.id),
            onMessage,
          }}
          deleteTitle={
            cullable
              ? "Remove this session (optionally delete its files)"
              : "Remove this session from the database"
          }
        />
      </div>

      <div className="session-detail-stats">
        <div className="session-stat-group" aria-label="Derivatives">
          <span className="pill total">{total} media</span>
          <span className="pill ready">{ready} ready</span>
          {pending > 0 && <span className="pill pending">{pending} pending</span>}
          {errors > 0 && <span className="pill error">{errors} errors</span>}
        </div>
        <div className="session-stat-group" aria-label="Triage">
          <span className="pill picks">{picks} picks</span>
          <span className="pill rejects">{rejects} rejects</span>
          <span className="pill unrated">{unrated} unrated</span>
        </div>
      </div>

      <div className="session-progress" title={`${triaged} of ${total} triaged`}>
        <div className="session-progress-track">
          <span
            className="session-progress-fill is-pick"
            style={{ width: `${total ? (picks / total) * 100 : 0}%` }}
          />
          <span
            className="session-progress-fill is-reject"
            style={{ width: `${total ? (rejects / total) * 100 : 0}%` }}
          />
        </div>
        <span className="session-progress-label">{pct}% triaged</span>
      </div>
    </section>
  );
}
