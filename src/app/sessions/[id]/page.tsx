"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  use as usePromise,
} from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { fetchJson } from "@/lib/fetchJson";
import AssetActionMenu, {
  type AssetMenuAction,
} from "@/app/gallery/AssetActionMenu";
import SimilarStrip from "@/app/gallery/SimilarStrip";
import MediaViewer from "@/app/MediaViewer";
import ViewerActions from "@/app/ViewerActions";
import BulkActionBar from "@/app/BulkActionBar";
import GeotagRecapModal from "@/app/GeotagRecapModal";
import type { PickedLocation } from "@/app/LocationPickerModal";
import DeleteSessionModal from "@/app/sessions/DeleteSessionModal";
import ExportSessionModal from "@/app/sessions/ExportSessionModal";
import SessionActions from "@/app/sessions/SessionActions";
import SessionProgress from "@/app/sessions/SessionProgress";
import PullToRefresh from "@/app/PullToRefresh";
import { Icons } from "@/app/ui";
import { formatBadge } from "@/lib/format";
import {
  deleteAssets,
  downloadAssetOriginal,
  geocodeAssets,
  mlAnalyzeAssets,
  rateAssets,
  regenerateAssets,
  sessionDownloadFiles,
  sessionGeotagAssets,
  tagAssets,
  type GeotagAsset,
} from "@/lib/assetActions";
import ExportSelectionModal from "@/app/exports/ExportSelectionModal";
import type { SessionStatus } from "@/lib/types";

// Leaflet touches `window` on import, so the geotag location picker (which
// embeds a map) is client-only — same treatment as the gallery's MapView.
const LocationPickerModal = dynamic(() => import("@/app/LocationPickerModal"), {
  ssr: false,
});

type Verdict = "pick" | "reject" | "skip" | "unrated";
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
  // 'manual' when the position was hand-set through the geotag action (cf.
  // api/assets/geotag) — the recap modal badges it to tell it from a camera fix.
  gps_source?: "manual" | null;
  rel_path: string | null;
  // Reverse-geocoded place (cf. lib/geocode.ts) — surfaced in the viewer's
  // metadata panel; `geocode_status` flips optimistically during a resolve.
  geocode_status?: string | null;
  place_country?: string | null;
  place_region?: string | null;
  place_county?: string | null;
  place_city?: string | null;
  place_poi?: string | null;
  // ML analysis (faces + OCR, cf. lib/ml.ts) — surfaced in the viewer's
  // metadata panel; `ml_status` flips optimistically during a re-analysis.
  ml_status?: string | null;
  face_count?: number | null;
  ocr_text?: string | null;
  sharpness?: number | null;
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
  status: SessionStatus;
  root_kind: "source" | "finals" | "inbox" | "export";
  root_path: string;
  ready_count: number | string;
  pending_count: number | string;
  error_count: number | string;
  live_count: number | string;
  pick_count: number | string;
  reject_count: number | string;
  skip_count: number | string;
  unrated_count: number | string;
  raw_jpeg_pairs: number | string;
  live_photo_pairs: number | string;
  exporting: boolean;
  export_count: number | string;
  last_exported_at: string | null;
};

const VERDICT_FILTERS: Array<{ key: string; label: string }> = [
  { key: "", label: "All" },
  { key: "unrated", label: "Unrated" },
  { key: "pick", label: "Picks" },
  { key: "reject", label: "Rejects" },
  { key: "skip", label: "Skipped" },
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
  const [exporting, setExporting] = useState(false);
  // Ids awaiting an ad-hoc export: non-null opens the selection export modal.
  const [exportIds, setExportIds] = useState<number[] | null>(null);
  // Bulk selection (mirrors the library grid): a toggleable select mode plus the
  // chosen ids. Tapping a cell toggles instead of opening the viewer while on.
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const sentinel = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);

  // Land the grid back on the media the viewer was showing when it closes. The
  // grid is a plain (non-virtualized) list mounted under the overlay, so every
  // loaded cell is in the DOM; scroll the one at `index` into view. "nearest"
  // is a no-op when it's already visible, so a close without far navigation
  // leaves the scroll where it was.
  const scrollToViewed = useCallback((index: number) => {
    requestAnimationFrame(() => {
      gridRef.current
        ?.querySelector<HTMLElement>(`[data-idx="${index}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
  }, []);

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
        // Small first page for a fast first paint, big follow-ups so deep
        // scrolling stays cheap in round-trips (mirrors GalleryShell).
        sp.set("limit", cur ? "200" : "60");
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

  const toggleSelect = useCallback((id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  // Verdict/stars on a set of ids (single = [id]), optimistic + bulk endpoint.
  const rateMany = useCallback(
    async (ids: number[], patch: { verdict?: Verdict; star?: number }) => {
      if (!ids.length) return;
      const idset = new Set(ids);
      setAssets((prev) =>
        prev.map((a) => (idset.has(a.id) ? { ...a, ...patch } : a)),
      );
      await rateAssets(ids, patch);
      void loadSession();
    },
    [loadSession],
  );

  // Add/remove a tag across the selection. Session cells don't render tags, so
  // there's no local state to patch — just hit the API and confirm.
  const tagSelection = useCallback(
    async (ids: number[], name: string, add: boolean) => {
      if (!ids.length || !name.trim()) return;
      await tagAssets(ids, name, add);
      setNotice(`${add ? "Tagged" : "Untagged"} “${name.trim()}”`);
    },
    [],
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
      setSelected((prev) => {
        const next = new Set(prev);
        ids.forEach((i) => next.delete(i));
        return next;
      });
      await deleteAssets(ids);
      setNotice(ids.length > 1 ? `${ids.length} deleted` : "Deleted");
      void loadSession();
      return true;
    },
    [loadSession],
  );

  // Opens the export modal for exactly these ids (dynamic file picker — same
  // flow as the gallery), instead of the old silent fire-and-forget POST.
  const exportSelection = useCallback((ids: number[]) => {
    if (!ids.length) return;
    setExportIds(ids);
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

  // Resolve GPS coordinates to place names (precise: also fills the tourist POI).
  const geocode = useCallback(async (ids: number[]) => {
    if (!ids.length) return;
    const idset = new Set(ids);
    setAssets((prev) =>
      prev.map((a) =>
        idset.has(a.id) ? { ...a, geocode_status: "pending" } : a,
      ),
    );
    try {
      const n = await geocodeAssets(ids, { precise: true });
      if (n === 0) setNotice("No GPS coordinates to resolve");
      else setNotice(n > 1 ? `Resolving ${n} locations` : "Resolving location");
    } catch (e) {
      setNotice((e as Error).message);
    }
  }, []);

  // --- Manual geotag (two-step: location picker, then before/after recap) ---
  // `ids` is the frozen selection the flow was opened for; `loc` flips the flow
  // from step 1 (pick a point) to step 2 (confirm per-media). `recap`, when
  // set, is a prefetched whole-session media list (the header's Geotag action —
  // it must cover the session's every media, not just the loaded page).
  const [geotag, setGeotag] = useState<{
    ids: number[];
    recap?: GeotagAsset[];
    loc?: PickedLocation;
  } | null>(null);

  const openGeotag = useCallback((ids: number[]) => {
    if (ids.length) setGeotag({ ids });
  }, []);

  // Header action: geotag the WHOLE session. The grid may only have a page
  // loaded, so pull the full media list (paged) first.
  const openSessionGeotag = useCallback(async () => {
    try {
      const recap = await sessionGeotagAssets(Number(id));
      if (!recap.length) {
        setNotice("No media in this session to geotag.");
        return;
      }
      setGeotag({ ids: recap.map((a) => a.id), recap });
    } catch (e) {
      setNotice((e as Error).message);
    }
  }, [id]);

  // Recap confirmed & applied: reflect the new position (and the queued
  // pipelines) in the grid rows without a refetch, like the other bulk actions.
  const geotagApplied = useCallback(
    (message: string, ids: number[], loc: PickedLocation) => {
      const idset = new Set(ids);
      setAssets((prev) =>
        prev.map((a) =>
          idset.has(a.id)
            ? {
                ...a,
                gps: { lat: loc.lat, lon: loc.lon },
                gps_source: "manual" as const,
                geocode_status: "pending",
              }
            : a,
        ),
      );
      setGeotag(null);
      setNotice(message);
    },
    [],
  );

  // (Re)run the ML analysis (face detection + OCR, cf. lib/ml.ts).
  const mlAnalyze = useCallback(async (ids: number[]) => {
    if (!ids.length) return;
    const idset = new Set(ids);
    setAssets((prev) =>
      prev.map((a) => (idset.has(a.id) ? { ...a, ml_status: "pending" } : a)),
    );
    try {
      const n = await mlAnalyzeAssets(ids);
      if (n === 0) setNotice("No derivative to analyze yet");
      else setNotice(n > 1 ? `Analyzing ${n} media` : "Analyzing media");
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

  const exportPicks = useCallback(() => {
    if (session) setExporting(true);
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
        case "geocode":
          return void geocode([id]);
        case "ml":
          return void mlAnalyze([id]);
        case "delete":
          return void removeAssets([id]);
      }
    },
    [rate, addTag, exportSelection, regenerate, geocode, mlAnalyze, removeAssets],
  );

  // Keyboard navigation in the viewer (desktop).
  // Rating shortcuts inside the viewer. Escape/arrow navigation is owned by
  // MediaViewer; this only adds the verdict (p/x/u) and star (0–5) keys.
  // P/X mirror the action bar's toggle: re-pressing the active verdict clears
  // it back to unrated (same as clicking the lit button). Stars keep explicit
  // set/clear (1–5/0).
  const onViewerKey = useCallback(
    (e: KeyboardEvent, a: AssetRow) => {
      if (e.key.toLowerCase() === "p")
        return void rate(a.id, { verdict: a.verdict === "pick" ? "unrated" : "pick" });
      if (e.key.toLowerCase() === "x")
        return void rate(a.id, { verdict: a.verdict === "reject" ? "unrated" : "reject" });
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

      <PullToRefresh className="session-view-body" onRefresh={refresh}>
        {session && (
          <SessionHeader
            s={session}
            onIgnore={toggleIgnore}
            onExportPicks={exportPicks}
            onGeotag={() => void openSessionGeotag()}
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
          <button
            className={`btn${selectMode ? " btn-primary" : ""}`}
            onClick={() => {
              setSelectMode((m) => !m);
              setSelected(new Set());
            }}
          >
            {selectMode ? "Done" : "Select"}
          </button>
          <span className="spacer" />
          <span className="hint">
            Keyboard: P pick · X reject · U clear · 1-5 stars · ←/→
          </span>
        </div>

        {selectMode && (
          <BulkActionBar
            count={selected.size}
            onSelectAll={() => setSelected(new Set(assets.map((a) => a.id)))}
            onClear={() => setSelected(new Set())}
            onPick={() => rateMany([...selected], { verdict: "pick" })}
            onReject={() => rateMany([...selected], { verdict: "reject" })}
            onStar={(n) => rateMany([...selected], { star: n })}
            onTag={(name, add) => tagSelection([...selected], name, add)}
            onExport={() => exportSelection([...selected])}
            onRegenerate={() => regenerate([...selected])}
            onGeocode={() => geocode([...selected])}
            onGeotag={() => openGeotag([...selected])}
            onMl={() => mlAnalyze([...selected])}
            onDelete={() => removeAssets([...selected])}
          />
        )}

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
          <div className="grid" ref={gridRef}>
            {assets.map((a, i) => {
              const sel = selectMode && selected.has(a.id);
              return (
              <div
                key={a.id}
                data-idx={i}
                className={`cell ${a.verdict}${sel ? " selected" : ""}`}
                onClick={() => (selectMode ? toggleSelect(a.id) : setViewer(i))}
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
                {sel && <span className="select-check">✓</span>}
              </div>
              );
            })}
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
          hasMore={hasMore}
          loading={loading}
          loadMore={() => fetchPage(cursor)}
          onClose={() => {
            scrollToViewed(viewer);
            setViewer(null);
          }}
          onKeyDown={onViewerKey}
          onContextMenu={(e, a) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, id: a.id });
          }}
          renderInfo={(a) => (
            <SimilarStrip
              assetId={a.id}
              onOpen={(id) => {
                // Jump the viewer when the similar shot belongs to this
                // session's loaded grid; otherwise say why nothing happened.
                const idx = assets.findIndex((x) => x.id === id);
                if (idx >= 0) setViewer(idx);
                else setNotice("Not in this session — find it from the Gallery");
              }}
            />
          )}
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
              onGeocode={() => geocode([a.id])}
              onGeotag={() => openGeotag([a.id])}
              onMl={() => mlAnalyze([a.id])}
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

      {geotag && !geotag.loc && (
        <LocationPickerModal
          count={geotag.ids.length}
          // Re-tagging a single already-positioned media: start from its point.
          initial={
            geotag.ids.length === 1
              ? assets.find((a) => a.id === geotag.ids[0])?.gps ?? null
              : null
          }
          onClose={() => setGeotag(null)}
          onPicked={(loc) => setGeotag({ ids: geotag.ids, loc })}
        />
      )}
      {geotag?.loc && (
        <GeotagRecapModal
          assets={
            geotag.recap ??
            geotag.ids.flatMap((id) => {
              const a = assets.find((x) => x.id === id);
              return a
                ? [
                    {
                      id: a.id,
                      filename: a.filename,
                      media_type: a.media_type,
                      gps: a.gps,
                      gps_source: a.gps_source ?? null,
                      place_city: a.place_city,
                      place_country: a.place_country,
                    },
                  ]
                : [];
            })
          }
          target={geotag.loc}
          onClose={() => setGeotag(null)}
          onApplied={(message, ids) => geotagApplied(message, ids, geotag.loc!)}
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

      {exportIds && (
        <ExportSelectionModal
          ids={exportIds}
          onClose={() => setExportIds(null)}
          onSubmitted={(message) => {
            setExportIds(null);
            setNotice(message);
          }}
        />
      )}

      {exporting && session && (
        <ExportSessionModal
          session={{
            id: session.id,
            name: session.name,
            pick_count: Number(session.pick_count),
            reject_count: Number(session.reject_count),
            unrated_count: Number(session.unrated_count),
            raw_jpeg_pairs: Number(session.raw_jpeg_pairs),
            live_photo_pairs: Number(session.live_photo_pairs),
          }}
          onClose={() => setExporting(false)}
          onSubmitted={(msg) => {
            setExporting(false);
            setNotice(msg);
            void loadSession();
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
  onIgnore,
  onExportPicks,
  onGeotag,
  onDelete,
  onMessage,
}: {
  s: SessionInfo;
  onIgnore: () => void;
  onExportPicks: () => void;
  /** Set the capture location of the whole session (picker + recap flow). */
  onGeotag: () => void;
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
  const skips = Number(s.skip_count) || 0;
  const unrated = Number(s.unrated_count) || 0;
  const cullable = s.root_kind === "source" || s.root_kind === "inbox";

  return (
    <section className={`session-detail${s.ignored ? " ignored" : ""}`}>
      <div className="session-detail-top">
        <div className="session-detail-info">
          <div className="session-detail-loc" title={s.source_path}>
            {Icons.folder}
            <span className="session-detail-path">{s.source_path}</span>
            <span className="chip session-detail-kind">{roleLabel(s.root_kind)}</span>
            {s.status === "done" && <span className="pill done">✓ done</span>}
            {s.ignored && <span className="pill">ignored</span>}
            {s.exporting ? (
              <span className="pill exporting" title="An export is queued or running">
                ⏳ exporting…
              </span>
            ) : (
              (Number(s.export_count) || 0) > 0 && (
                <span
                  className="pill exported"
                  title={
                    s.last_exported_at
                      ? `Last exported ${fmtDate(s.last_exported_at)}`
                      : "Already exported"
                  }
                >
                  ✓ exported
                  {(Number(s.export_count) || 0) > 1
                    ? ` ×${Number(s.export_count)}`
                    : ""}
                </span>
              )
            )}
          </div>
          <div className="session-detail-meta">
            {(s.device_hint ?? "device ?") + " · "}
            {fmtDate(s.captured_at_min)} → {fmtDate(s.captured_at_max)}
            {" · "}
            {s.asset_count} files
          </div>
        </div>

        <SessionActions
          ignored={s.ignored}
          canExport={picks > 0}
          onIgnore={onIgnore}
          onExportPicks={onExportPicks}
          onGeotag={onGeotag}
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
          {skips > 0 && <span className="pill skips">{skips} skipped</span>}
          <span className="pill unrated">{unrated} unrated</span>
        </div>
      </div>

      <SessionProgress picks={picks} rejects={rejects} skips={skips} total={total} />

      {cullable && total > 0 && unrated > 0 && (
        <Link href={`/sift/${s.id}`} className="btn btn-primary session-detail-sift">
          {Icons.sift} Sift {unrated} unrated
        </Link>
      )}
    </section>
  );
}
