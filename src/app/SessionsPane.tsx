"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { fetchJson } from "@/lib/fetchJson";
import { sessionDownloadFiles } from "@/lib/assetActions";
import type { SessionStatus } from "@/lib/types";
import { SkeletonCards, EmptyState, Icons, LazyImage } from "./ui";
import DeleteSessionModal from "./sessions/DeleteSessionModal";
import ExportSessionModal from "./sessions/ExportSessionModal";
import SessionActions from "./sessions/SessionActions";
import SessionProgress from "./sessions/SessionProgress";
import ThumbStrip, { type StripItem } from "./ThumbStrip";
import PullToRefresh from "./PullToRefresh";

// The incoming "Sessions" view: the work queue of scanned NAS folders.
//  - counters + actions per session (ignore, export picks to C1); a session's
//    "done" badge is computed from its verdict coverage, not hand-set;
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
  status: SessionStatus;
  ready_count: number;
  pending_count: number;
  error_count: number;
  pick_count: number;
  reject_count: number;
  skip_count: number;
  unrated_count: number;
  last_reviewed_at: string | null;
  raw_jpeg_pairs: number;
  live_photo_pairs: number;
  exporting: boolean;
  export_count: number;
  last_exported_at: string | null;
  sample_assets: SampleAsset[];
};

// Every verdict (pick + reject + skip) plus the still-unrated media: every asset
// falls in exactly one bucket, so the counts sum to the cullable total.
function triageTotal(s: SessionRow): number {
  return (
    Number(s.pick_count) +
    Number(s.reject_count) +
    Number(s.skip_count) +
    Number(s.unrated_count)
  );
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

// A session's export state: a live "exporting…" pill while a job is in flight,
// otherwise a persistent "exported ×N" pill (with the last date on hover) once
// it has ever been exported. Nothing shown for a never-exported session.
function ExportBadge({ s }: { s: SessionRow }) {
  if (s.exporting) {
    return (
      <span className="pill exporting" title="An export is queued or running">
        ⏳ exporting…
      </span>
    );
  }
  const count = Number(s.export_count) || 0;
  if (count > 0) {
    return (
      <span
        className="pill exported"
        title={
          s.last_exported_at
            ? `Last exported ${fmtDate(s.last_exported_at)}`
            : "Already exported"
        }
      >
        ✓ exported{count > 1 ? ` ×${count}` : ""}
      </span>
    );
  }
  return null;
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
      {s.status === "done" && <span className="pill done">✓ done</span>}
      <ExportBadge s={s} />
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

// Returning to the list — most often after diving into a session and hitting
// Back — remounts this pane from scratch: empty state, a skeleton, a full
// refetch, and the scroll snapped back to the top. That throws away the place
// you were working. This module-level store survives the unmount/remount across
// client navigations (it is intentionally dropped on a hard reload) and holds,
// per filter view, the rows last fetched and where the list was scrolled, so a
// remount can paint the same rows at the same offset instead of starting over.
type PaneCache = { sessions: SessionRow[]; scrollTop: number };
const paneCache = new Map<string, PaneCache>();

// A view is identified by its scope+filters, sort direction, and progress
// filter — exactly what drives the fetch — so each keeps its own rows/offset.
function paneKey(query: string, sortDir: SortDir, progress: string): string {
  return `${query}|${sortDir}|${progress}`;
}

// Restore the scroll offset before the browser paints (no top-then-jump
// flicker), falling back to a plain effect on the server where layout effects
// don't run — the store is empty there anyway, so it's a no-op.
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

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
  const cacheKey = paneKey(query, sortDir, progress);
  // The live key, reachable from the scroll listener without re-subscribing it.
  const cacheKeyRef = useRef(cacheKey);
  cacheKeyRef.current = cacheKey;
  // The list scroller (`.sessions-pane`) — we read its offset here to save it,
  // and seek it back on remount.
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  // Seed from the cache so a remount paints the last-seen rows immediately.
  const [sessions, setSessions] = useState<SessionRow[]>(
    () => paneCache.get(cacheKey)?.sessions ?? [],
  );
  // Skip the skeleton when we already have rows to show; the poll below still
  // refreshes them in the background.
  const [loading, setLoading] = useState(() => !paneCache.has(cacheKey));
  const [error, setError] = useState<string | null>(null);
  // Session pending a delete confirmation (opens the modal); transient toast.
  const [confirming, setConfirming] = useState<SessionRow | null>(null);
  // Session whose export modal is open.
  const [exporting, setExporting] = useState<SessionRow | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchJson<{ sessions?: SessionRow[] }>(
        `/api/sessions?${query}&sort_dir=${sortDir}${progress ? `&progress=${progress}` : ""}`,
      );
      const rows = data.sessions ?? [];
      setSessions(rows);
      // Keep the cache warm (preserving the saved scroll offset) so the next
      // remount paints these rows at once instead of refetching from empty.
      const key = paneKey(query, sortDir, progress);
      paneCache.set(key, {
        sessions: rows,
        scrollTop: paneCache.get(key)?.scrollTop ?? 0,
      });
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [query, sortDir, progress]);

  // On a filter/sort change, adopt that view's cached rows instantly if we have
  // them (a background refresh follows); otherwise show the skeleton and reset
  // to the top. The initial mount is already seeded above, so skip it — and
  // guarding on the previous key keeps a StrictMode remount from resetting the
  // very scroll offset we're about to restore.
  const prevKeyRef = useRef(cacheKey);
  useEffect(() => {
    if (prevKeyRef.current === cacheKey) return;
    prevKeyRef.current = cacheKey;
    const cached = paneCache.get(cacheKey);
    setSessions(cached?.sessions ?? []);
    setLoading(!cached);
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
  }, [cacheKey]);

  // Polls while mounted (i.e. while this view is active) to follow the
  // derivatives' progress.
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  // Track the scroll offset as it changes so a later remount can restore it.
  // Reads the live key via the ref, so it never needs to re-bind on a change.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = () => {
      const entry = paneCache.get(cacheKeyRef.current);
      if (entry) entry.scrollTop = el.scrollTop;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Restore the saved offset on mount, before paint. The seeded rows are already
  // laid out and `content-visibility` gives off-screen cards an intrinsic
  // height, so the scroller is tall enough to seek into on the first frame.
  useIsomorphicLayoutEffect(() => {
    const el = scrollerRef.current;
    const saved = paneCache.get(cacheKey)?.scrollTop ?? 0;
    if (el && saved > 0) el.scrollTop = saved;
    // Mount-only: later key changes are handled by the effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  function sessionActions(s: SessionRow) {
    return (
      <SessionActions
        ignored={s.ignored}
        canExport={s.pick_count > 0}
        onIgnore={() => toggleIgnore(s)}
        onExportPicks={() => setExporting(s)}
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
    <PullToRefresh
      className="sessions-pane"
      onRefresh={load}
      scrollerRef={scrollerRef}
    >
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
                  skips={Number(s.skip_count)}
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
                skips={Number(s.skip_count)}
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

      {exporting && (
        <ExportSessionModal
          session={exporting}
          onClose={() => setExporting(null)}
          onSubmitted={(msg) => {
            setExporting(null);
            setNotice(msg);
            void load();
          }}
        />
      )}
    </PullToRefresh>
  );
}
