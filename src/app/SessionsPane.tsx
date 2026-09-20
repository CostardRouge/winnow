"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { fetchJson } from "@/lib/fetchJson";
import {
  sessionDownloadFiles,
  sessionGeotagAssets,
  type GeotagAsset,
} from "@/lib/assetActions";
import type { SessionStatus } from "@/lib/types";
import { SkeletonCards, EmptyState, Icons, LazyImage } from "./ui";
import { formatCaptureSpan } from "@/lib/format";
import { useFeatures } from "./FeaturesProvider";
import DeleteSessionModal from "./sessions/DeleteSessionModal";
import ExportSessionModal from "./sessions/ExportSessionModal";
import SessionMenu from "./sessions/SessionMenu";
import SessionProgress from "./sessions/SessionProgress";
import GeotagRecapModal from "./GeotagRecapModal";
import type { PickedLocation } from "./LocationPickerModal";
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

// Leaflet touches `window` on import, so the geotag location picker (which
// embeds a map) is client-only — same treatment as the gallery's MapView.
const LocationPickerModal = dynamic(() => import("./LocationPickerModal"), {
  ssr: false,
});

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

// One line under the title: when (the capture span humanised by
// formatCaptureSpan — the card used to print two numeric dates with an arrow
// even when they were the same day), what shot it, how many files. The three
// facts are separate spans because only ONE of them may be sacrificed when the
// line is too narrow: the device name is the long, unpredictable token (a lens
// or body string, or "unknown device"), so it alone shrinks and ellipses while
// the span and the file count always print in full. Letting the whole sentence
// wrap is what made a card two or three lines taller than the ones beside it
// in the grid, and a grid row is as tall as its tallest card.
function SessionMetaLine({ s }: { s: SessionRow }) {
  const device = s.device_hint ?? "unknown device";
  return (
    <span className="meta-line">
      <span className="meta-when">
        {formatCaptureSpan(s.captured_at_min, s.captured_at_max)}
      </span>
      <span className="meta-sep">·</span>
      <span className="meta-device" title={device}>
        {device}
      </span>
      <span className="meta-sep">·</span>
      <span className="meta-count">
        {s.asset_count} {s.asset_count === 1 ? "file" : "files"}
      </span>
    </span>
  );
}

// Only the states worth a chip: previews still pending or in error, and the
// export state (a live "exporting…", or "exported" once it has been). The
// ready count, the picks pill and the "✓ done" badge are gone: the progress
// line below the strip says all three (UI review H3). The session page's
// subtitle prints the same line (SessionGrid).
function SessionFlags({ s }: { s: SessionRow }) {
  const pending = Number(s.pending_count) || 0;
  const errors = Number(s.error_count) || 0;
  const exportCount = Number(s.export_count) || 0;
  return (
    <>
      {pending > 0 && (
        <span className="pill pending" title="Previews still being built">
          {pending} pending
        </span>
      )}
      {errors > 0 && (
        <span className="pill error" title="Previews that failed to build">
          {errors} {errors === 1 ? "error" : "errors"}
        </span>
      )}
      {s.exporting ? (
        <span className="pill exporting" title="An export is queued or running">
          exporting…
        </span>
      ) : exportCount > 0 ? (
        <span
          className="pill"
          title={
            s.last_exported_at
              ? `Last exported ${fmtDate(s.last_exported_at)}`
              : "Already exported"
          }
        >
          {Icons.keep} exported{exportCount > 1 ? ` ×${exportCount}` : ""}
        </span>
      ) : null}
    </>
  );
}

// The list layout has the width for the sentence and its chips on one line.
function SessionMeta({ s }: { s: SessionRow }) {
  return (
    <div className="meta">
      <SessionMetaLine s={s} />
      <SessionFlags s={s} />
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

/** How far each card of the deck peeks out from under the one in front. */
const STACK_PEEK = 8;

// An overlapping "deck" of a few thumbnails (card layout): front-most first.
//
// The deck's FOOTPRINT is the same box whatever the count — the room the back
// cards need is taken out of the front card, not added around the deck. A
// session with one preview therefore fills the box edge to edge instead of
// leaving a strip of paper down its right side, and every card in a grid row
// still gets the same height (a box that grew with the sample count would make
// the row as tall as its deepest deck).
function ThumbStack({ samples }: { samples: SampleAsset[] }) {
  const shown = (samples ?? []).slice(0, 3).map((a) => a.id);
  if (shown.length === 0) {
    return <div className="thumb-stack is-empty">No preview yet</div>;
  }
  const reserved = (shown.length - 1) * STACK_PEEK;
  return (
    <div className="thumb-stack">
      {shown.map((id, i) => {
        const depth = shown.length - 1 - i; // 0 = front-most card
        return (
          <LazyImage
            key={id}
            className="thumb-stack-item no-pin-hover"
            src={`/api/assets/${id}/thumb`}
            alt=""
            style={{
              // Every card is the front card's size; the deeper ones are slid
              // down-right until the last one touches the box's corner.
              right: reserved,
              bottom: reserved,
              zIndex: shown.length - depth,
              transform: `translate(${depth * STACK_PEEK}px, ${depth * STACK_PEEK}px)`,
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
  const features = useFeatures();
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

  // --- Session-level geotag (picker → per-media recap) ----------------------
  // The list has no asset grid loaded, so opening the flow first pulls the
  // session's full media list (paged) into the recap shape. `assets` present =
  // picker open; `loc` set = recap open.
  const [geotag, setGeotag] = useState<{
    session: SessionRow;
    assets: GeotagAsset[];
    loc?: PickedLocation;
  } | null>(null);
  // Guards double-clicks while a session's media list is being fetched.
  const [geotagLoading, setGeotagLoading] = useState(false);

  const openGeotag = useCallback(
    async (s: SessionRow) => {
      if (geotagLoading) return;
      setGeotagLoading(true);
      try {
        const assets = await sessionGeotagAssets(s.id);
        if (!assets.length) {
          setNotice("No media in this session to geotag.");
          return;
        }
        setGeotag({ session: s, assets });
      } catch (e) {
        setNotice((e as Error).message);
      } finally {
        setGeotagLoading(false);
      }
    },
    [geotagLoading],
  );

  async function toggleIgnore(s: SessionRow) {
    await fetch(`/api/sessions/${s.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ignored: !s.ignored }),
    });
    await load();
  }

  // One primary verb per card — the thing the session is waiting for — and the
  // rest behind ⋯ (UI review H2). While frames are unrated the verb is to sort
  // them: the Sift deck when that section is on, the session grid otherwise.
  // Once sorting is done and there are picks that were never exported, the
  // verb is Export. Anything else (exported, ignored, empty) has no primary:
  // the card is the link, the menu has the rest.
  function primaryAction(s: SessionRow) {
    const unrated = Number(s.unrated_count) || 0;
    const picks = Number(s.pick_count) || 0;
    if (s.ignored) return null;
    if (unrated > 0) {
      return features.sift ? (
        <Link href={`/sift/${s.id}`} className="btn btn-primary card-primary">
          {Icons.sift} Sift {unrated}
        </Link>
      ) : (
        <Link href={`/sessions/${s.id}`} className="btn btn-primary card-primary">
          Sort {unrated}
        </Link>
      );
    }
    if (picks > 0 && !s.exporting && !(Number(s.export_count) > 0)) {
      return (
        <button
          className="btn btn-primary card-primary"
          onClick={() => setExporting(s)}
          title="Export the RAW picks to the Capture One export folder"
        >
          {Icons.upload} Export {picks} {picks === 1 ? "pick" : "picks"}
        </button>
      );
    }
    return null;
  }

  function sessionActions(s: SessionRow) {
    return (
      <div className="card-actions">
        {primaryAction(s)}
        <SessionMenu
          ignored={s.ignored}
          canExport={s.pick_count > 0}
          onIgnore={() => toggleIgnore(s)}
          onExportPicks={() => setExporting(s)}
          onGeotag={() => void openGeotag(s)}
          onDelete={() => setConfirming(s)}
          download={{
            zipHref: `/api/sessions/${s.id}/download`,
            zipName: `${s.name}.zip`,
            listFiles: () => sessionDownloadFiles(s.id),
            onMessage: setNotice,
          }}
        />
      </div>
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
          <Link href="/settings/volumes" className="btn btn-primary">
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
                {/* The state chips ride the cover rather than the meta line:
                    in a grid, a chip that wraps onto a second line stretches
                    every card of the row, and these appear on a minority of
                    sessions. Over the deck they cost no layout at all. */}
                <span className="card-flags">
                  <SessionFlags s={s} />
                </span>
              </Link>
              <div className="session-card-body">
                <h3>
                  <Link href={`/sessions/${s.id}`}>{s.name}</Link>
                </h3>
                <div className="meta">
                  <SessionMetaLine s={s} />
                </div>
                <SessionProgress
                  picks={Number(s.pick_count)}
                  rejects={Number(s.reject_count)}
                  skips={Number(s.skip_count)}
                  total={triageTotal(s)}
                  compact
                  legend
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
                <div className="card-side">{sessionActions(s)}</div>
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
                legend
              />
            </div>
          ))}
        </div>
      )}

      {geotag && !geotag.loc && (
        <LocationPickerModal
          count={geotag.assets.length}
          onClose={() => setGeotag(null)}
          onPicked={(loc) => setGeotag({ ...geotag, loc })}
        />
      )}
      {geotag?.loc && (
        <GeotagRecapModal
          assets={geotag.assets}
          target={geotag.loc}
          onClose={() => setGeotag(null)}
          onApplied={(message) => {
            setGeotag(null);
            setNotice(message);
            void load();
          }}
        />
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
