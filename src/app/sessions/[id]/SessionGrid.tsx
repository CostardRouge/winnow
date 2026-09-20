"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  use as usePromise,
  type ReactNode,
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
import PageHeader from "@/app/PageHeader";
import SessionMenu from "@/app/sessions/SessionMenu";
import SessionProgress from "@/app/sessions/SessionProgress";
import PullToRefresh from "@/app/PullToRefresh";
import { useFeatures } from "@/app/FeaturesProvider";
import { Icons } from "@/app/ui";
import { formatBadge, formatCaptureSpan } from "@/lib/format";
import {
  deleteAssets,
  downloadAssetOriginal,
  geocodeAssets,
  mlAnalyzeAssets,
  rateAssets,
  exemptAssets,
  regenerateAssets,
  selectionDownloadFiles,
  selectionZipHref,
  sessionDownloadFiles,
  geotagTargets,
  tagAssets,
  type GeotagAsset,
  type GeotagSource,
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
  // 'manual' when a human placed the pin, 'inferred' when a folder suggestion
  // was accepted in bulk (cf. api/assets/geotag) — the recap modal badges it to
  // tell either from a camera fix. `geo_exempt_at`: taken out of the geotag
  // backlog for good (cf. api/assets/geo-exempt).
  gps_source?: "manual" | "inferred" | null;
  geo_exempt_at?: string | null;
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
  // Burst/bracket stack (cf. lib/bursts.ts): the pile this frame belongs to,
  // its 1-based order inside it, and the pile's live frame count (served on
  // every member). In the collapsed grid only the pile's cover row shows, with
  // `burst_count` driving the stack badge; expanding drills in (?burst_id=) and
  // splices the members in place.
  burst_id?: number | null;
  burst_seq?: number | null;
  burst_count?: number | null;
  burst_cover_id?: number | null;
  // 'bracket' (exposure-bracketed / AEB) vs 'action' (continuous shooting) —
  // cf. Burst.kind, lib/bursts.ts.
  burst_kind?: "action" | "bracket" | null;
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

// The verdict filters, each with the session count it stands for so the toggle
// doubles as the status readout ("Unrated 5 · Picks 5 · Rejects 4" — UI review
// H3/H5: the same numbers used to be drawn again as five pills and a legend).
const VERDICT_FILTERS: Array<{
  key: string;
  label: string;
  count: (s: SessionInfo) => number;
}> = [
  { key: "", label: "All", count: (s) => Number(s.live_count) || 0 },
  { key: "unrated", label: "Unrated", count: (s) => Number(s.unrated_count) || 0 },
  { key: "pick", label: "Picks", count: (s) => Number(s.pick_count) || 0 },
  { key: "reject", label: "Rejects", count: (s) => Number(s.reject_count) || 0 },
  { key: "skip", label: "Skipped", count: (s) => Number(s.skip_count) || 0 },
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
  return kind === "finals" ? "Final" : kind === "export" ? "Export" : "Incoming";
}
function isCullable(s: SessionInfo): boolean {
  return s.root_kind === "source" || s.root_kind === "inbox";
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
  // Expanded burst piles: burst_id → the cover row's id (so collapsing restores
  // exactly the tile that stood for the pile). Cleared on every grid reload.
  const [expandedBursts, setExpandedBursts] = useState<Map<number, number>>(
    new Map(),
  );

  // Sharpest loaded frame of each EXPANDED pile (burst_id → asset id), for the
  // "◆" hint chip — a nudge toward the keeper, fed by the sharpness analysis
  // (cf. lib/ml.ts). Only meaningful once a pile is expanded, and only over
  // frames that carry a score (unanalyzed frames never win by default).
  const sharpestByBurst = useMemo(() => {
    const best = new Map<number, { id: number; sharpness: number }>();
    for (const a of assets) {
      if (a.burst_id == null || a.sharpness == null) continue;
      if (!expandedBursts.has(a.burst_id)) continue;
      const cur = best.get(a.burst_id);
      if (!cur || a.sharpness > cur.sharpness)
        best.set(a.burst_id, { id: a.id, sharpness: a.sharpness });
    }
    return new Map([...best].map(([bid, v]) => [bid, v.id]));
  }, [assets, expandedBursts]);

  // This frame's live "x/n" position within its EXPANDED pile (asset id →
  // {rank, total}), for a per-member index badge. Ranked by where each frame
  // falls among the pile's other LOADED members — not the stored `burst_seq`,
  // which is assigned once at cluster time and never renumbered, so it can
  // skip (or even outrun `burst_count`) once a frame in the run is trashed.
  // Expanded members are spliced in capture order (cf. toggleStack), so a
  // single forward pass yields the correct rank.
  const burstRankById = useMemo(() => {
    const seen = new Map<number, number>();
    const ranks = new Map<number, { rank: number; total: number }>();
    for (const a of assets) {
      if (a.burst_id == null || !expandedBursts.has(a.burst_id)) continue;
      const rank = (seen.get(a.burst_id) ?? 0) + 1;
      seen.set(a.burst_id, rank);
      ranks.set(a.id, { rank, total: a.burst_count ?? rank });
    }
    return ranks;
  }, [assets, expandedBursts]);
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
    setExpandedBursts(new Map());
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

  // Expand a burst pile in place: drill into the stack (?burst_id= — the API
  // returns every frame of the pile, collapse suppressed) and splice the members
  // over the cover tile, so the viewer, selection and context menu work on them
  // like any other row. Collapsing puts the remembered cover tile back and drops
  // the other members from the list (nothing is refetched or mutated).
  const toggleStack = useCallback(
    async (a: AssetRow) => {
      const burstId = a.burst_id;
      if (burstId == null) return;
      const coverId = expandedBursts.get(burstId);
      if (coverId != null) {
        // Collapse: keep only the row that stood for the pile.
        setAssets((prev) =>
          prev.filter((x) => x.burst_id !== burstId || x.id === coverId),
        );
        setExpandedBursts((prev) => {
          const next = new Map(prev);
          next.delete(burstId);
          return next;
        });
        return;
      }
      try {
        // The pile is fetched WITHOUT the verdict filter: expanding is about
        // seeing the whole run, whatever each frame is rated. Piles are seconds
        // long, so one max-size page always covers a real burst.
        const data = await fetchJson<{ assets?: AssetRow[] }>(
          `/api/sessions/${id}/assets?burst_id=${burstId}&limit=500`,
        );
        const members = data.assets ?? [];
        if (!members.length) return;
        setAssets((prev) => {
          const at = prev.findIndex((x) => x.id === a.id);
          if (at < 0) return prev;
          return [...prev.slice(0, at), ...members, ...prev.slice(at + 1)];
        });
        setExpandedBursts((prev) => new Map(prev).set(burstId, a.id));
      } catch (e) {
        setNotice((e as Error).message);
      }
    },
    [id, expandedBursts],
  );

  // --- Pile actions (cf. lib/bursts.ts) — the "cull a pile in one gesture" ---
  // All explicit: rating a frame normally NEVER cascades to its pile; these
  // three are the deliberate whole-stack gestures, reachable from the context
  // menu of any pile frame (collapsed cover or expanded member, grid or viewer).

  // Pick / reject / clear the WHOLE pile. The server widens the id to every
  // live frame + pair companions (expand_bursts); locally every loaded row of
  // the pile follows (the collapsed cover included).
  const ratePile = useCallback(
    async (a: AssetRow, verdict: Verdict) => {
      const bid = a.burst_id;
      if (bid == null) return;
      setAssets((prev) =>
        prev.map((x) => (x.burst_id === bid ? { ...x, verdict } : x)),
      );
      await rateAssets([a.id], { verdict }, { expandBursts: true });
      setNotice(
        verdict === "pick"
          ? "Pile picked"
          : verdict === "reject"
            ? "Pile rejected"
            : "Pile verdicts cleared",
      );
      void loadSession();
    },
    [loadSession],
  );

  // The flagship gesture: keep THIS frame, reject every other frame of its
  // pile. Two sequential bulk calls — reject the whole pile, then pick the
  // keeper (each cascading to its pair companion server-side).
  const keepOne = useCallback(
    async (a: AssetRow) => {
      const bid = a.burst_id;
      if (bid == null) return;
      setAssets((prev) =>
        prev.map((x) =>
          x.burst_id === bid
            ? { ...x, verdict: x.id === a.id ? "pick" : "reject" }
            : x,
        ),
      );
      await rateAssets([a.id], { verdict: "reject" }, { expandBursts: true });
      await rateAssets([a.id], { verdict: "pick" });
      setNotice("Kept 1 — rest of the pile rejected");
      void loadSession();
    },
    [loadSession],
  );

  // Export the whole pile: resolve the live members (drill-in), then open the
  // regular selection export modal on exactly those ids.
  const exportPile = useCallback(
    async (a: AssetRow) => {
      const bid = a.burst_id;
      if (bid == null) return;
      try {
        const data = await fetchJson<{ assets?: AssetRow[] }>(
          `/api/sessions/${id}/assets?burst_id=${bid}&limit=500`,
        );
        const ids = (data.assets ?? []).map((x) => x.id);
        if (ids.length) setExportIds(ids);
      } catch (e) {
        setNotice((e as Error).message);
      }
    },
    [id],
  );

  // Keep-sharpest: same gesture as keepOne but the sharpness analysis (variance
  // of the Laplacian, cf. lib/ml.ts) picks the keeper among the pile's live
  // frames. Needs the members' sharpness → resolve them via the drill-in, then
  // delegate to keepOne on the winner. Frames not analyzed yet have no score;
  // if none has one, say so instead of guessing.
  const keepSharpest = useCallback(
    async (a: AssetRow) => {
      const bid = a.burst_id;
      if (bid == null) return;
      try {
        const data = await fetchJson<{ assets?: AssetRow[] }>(
          `/api/sessions/${id}/assets?burst_id=${bid}&limit=500`,
        );
        const members = (data.assets ?? []).filter((x) => x.sharpness != null);
        if (!members.length) {
          setNotice(
            "No sharpness scores in this pile yet — run “Detect faces & text” first",
          );
          return;
        }
        const winner = members.reduce((best, x) =>
          x.sharpness! > best.sharpness! ? x : best,
        );
        await keepOne(winner);
      } catch (e) {
        setNotice((e as Error).message);
      }
    },
    [id, keepOne],
  );

  // Re-cluster the whole session's piles with the current thresholds (cf.
  // lib/bursts.ts). The scan-time reconciler never reshapes an existing pile,
  // so threshold changes and late-arriving frames only take effect here.
  // Ratings are per-frame and survive; the grid reloads to show the new piles.
  const restack = useCallback(async () => {
    try {
      const data = await fetchJson<{ dissolved: number; created: number }>(
        `/api/sessions/${id}/restack`,
        { method: "POST" },
      );
      setNotice(`Restacked: ${data.created} piles (was ${data.dissolved})`);
      reset();
      await fetchPage(null);
    } catch (e) {
      setNotice((e as Error).message);
    }
  }, [id, reset, fetchPage]);

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

  // Take the selection out of the geotag backlog (or put it back): sets
  // geo_exempt_at on the rows and nothing else (cf. api/assets/geo-exempt).
  const exemptSelection = useCallback(
    async (ids: number[], exempt: boolean) => {
      if (!ids.length) return;
      try {
        const n = await exemptAssets(ids, exempt);
        const idset = new Set(ids);
        const stamp = exempt ? new Date().toISOString() : null;
        setAssets((prev) =>
          prev.map((a) =>
            idset.has(a.id) ? { ...a, geo_exempt_at: stamp } : a,
          ),
        );
        setNotice(
          exempt
            ? `${n} media marked as never needing a position`
            : `${n} media back in the geotag backlog`,
        );
      } catch (e) {
        setNotice((e as Error).message);
      }
    },
    [],
  );

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
      const recap = await geotagTargets([Number(id)]);
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
  // `source` is what the recap recorded — 'manual' from these entry points (a
  // pin placed by hand); the write-back only ran for that case.
  const geotagApplied = useCallback(
    (message: string, ids: number[], loc: PickedLocation, source: GeotagSource) => {
      const idset = new Set(ids);
      setAssets((prev) =>
        prev.map((a) =>
          idset.has(a.id)
            ? {
                ...a,
                gps: { lat: loc.lat, lon: loc.lon },
                gps_source: source,
                gps_write_status: source === "manual" ? "pending" : "skipped",
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

  // Dispatch a context-menu action onto a single asset. The pile_* kinds need
  // the full row (burst_id), so they resolve it from the loaded grid.
  const onMenuAction = useCallback(
    (id: number, action: AssetMenuAction) => {
      const row = assets.find((a) => a.id === id);
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
        case "pile_verdict":
          return row ? void ratePile(row, action.verdict) : undefined;
        case "pile_keep":
          return row ? void keepOne(row) : undefined;
        case "pile_keep_sharpest":
          return row ? void keepSharpest(row) : undefined;
        case "pile_export":
          return row ? void exportPile(row) : undefined;
      }
    },
    [
      assets,
      rate,
      addTag,
      exportSelection,
      regenerate,
      geocode,
      mlAnalyze,
      removeAssets,
      ratePile,
      keepOne,
      keepSharpest,
      exportPile,
    ],
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
      // Same soft-delete + confirm as the overflow menu's Delete entry.
      if (e.key === "Delete") return void removeAssets([a.id]);
    },
    [rate, removeAssets],
  );

  // The header's far end: the page's one primary verb + the ⋯ menu (H2/H5),
  // preceded by the transient notice when there is one. Undefined while the
  // session is still loading so the header renders no empty trailing slot
  // (which takes a line of its own on a phone).
  const headActions = session && (
    <SessionHeadActions
      s={session}
      onIgnore={toggleIgnore}
      onExportPicks={exportPicks}
      onGeotag={() => void openSessionGeotag()}
      onRestack={() => void restack()}
      onDelete={() => setConfirming(true)}
      onMessage={setNotice}
    />
  );

  return (
    <>
      <PageHeader
        back="/library/incoming/sessions"
        backLabel="Back to library"
        title={session?.name ?? `Session #${id}`}
        subtitle={session && <SessionMeta s={session} />}
        trailing={
          notice || headActions ? (
            <>
              {notice && <span className="notice">{notice}</span>}
              {headActions}
            </>
          ) : undefined
        }
      />

      {/* The one toolbar band (S3): the verdict filters as a counted segmented
          control, the triage bar beside them, Select at the far end. */}
      <div className="page-tools session-tools">
        <div className="view-toggle" role="group" aria-label="Show">
          {VERDICT_FILTERS.map((f) => (
            <button
              key={f.key}
              className={`view-btn${verdict === f.key ? " active" : ""}`}
              aria-pressed={verdict === f.key}
              onClick={() => setVerdict(f.key)}
            >
              {f.label}
              {session && <span className="view-count">{f.count(session)}</span>}
            </button>
          ))}
        </div>
        {session && (
          <SessionProgress
            picks={Number(session.pick_count) || 0}
            rejects={Number(session.reject_count) || 0}
            skips={Number(session.skip_count) || 0}
            total={Number(session.live_count) || 0}
            className="session-tools-progress"
          />
        )}
        <span className="spacer" />
        <span className="kbd-hint">P pick · X reject · U clear · 1–5 stars · ←/→</span>
        <button
          className={`btn${selectMode ? " btn-primary" : ""}`}
          aria-pressed={selectMode}
          onClick={() => {
            setSelectMode((m) => !m);
            setSelected(new Set());
          }}
        >
          {selectMode ? "Done" : "Select"}
        </button>
      </div>

      <PullToRefresh className="session-view-body" onRefresh={refresh}>
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
            download={{
              zipHref: selectionZipHref([...selected]),
              zipName: "winnow-selection.zip",
              listFiles: () =>
                Promise.resolve(
                  selectionDownloadFiles(
                    assets.filter((a) => selected.has(a.id)),
                  ),
                ),
              onMessage: setNotice,
            }}
            onRegenerate={() => regenerate([...selected])}
            onGeocode={() => geocode([...selected])}
            onGeotag={() => openGeotag([...selected])}
            onExempt={(exempt) => exemptSelection([...selected], exempt)}
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
          // has-bulk-bar: clearance under the grid while the floating selection
          // bar is up, so the last rows can scroll past it (cf. globals.css).
          <div
            className={`grid${selectMode ? " has-bulk-bar" : ""}`}
            ref={gridRef}
          >
            {assets.map((a, i) => {
              const sel = selectMode && selected.has(a.id);
              // Burst pile affordances: a collapsed pile shows as one cover tile
              // (count badge, click to expand); expanded members get the
              // in-stack styling, with the collapse control on the cover.
              const stackExpanded =
                a.burst_id != null && expandedBursts.has(a.burst_id);
              const isStackCover =
                (a.burst_count ?? 0) > 1 && !stackExpanded;
              const isExpandedCover =
                stackExpanded && expandedBursts.get(a.burst_id!) === a.id;
              const frameIndex = stackExpanded ? burstRankById.get(a.id) : undefined;
              return (
              <div
                key={a.id}
                data-idx={i}
                className={`cell ${a.verdict}${sel ? " selected" : ""}${
                  stackExpanded ? " in-stack" : ""
                }`}
                onClick={() =>
                  selectMode
                    ? toggleSelect(a.id)
                    : isStackCover
                      ? void toggleStack(a)
                      : setViewer(i)
                }
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
                {!sel && isStackCover && (
                  <button
                    className={`stack-badge${a.burst_kind === "bracket" ? " bracket" : ""}`}
                    title={
                      a.burst_kind === "bracket"
                        ? `Exposure-bracketed (AEB) pile — expand ${a.burst_count} frames`
                        : `Burst pile — expand ${a.burst_count} frames`
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      void toggleStack(a);
                    }}
                  >
                    {a.burst_kind === "bracket" ? "±" : "⧉"} {a.burst_count}
                  </button>
                )}
                {!sel && isExpandedCover && (
                  <button
                    className={`stack-badge open${a.burst_kind === "bracket" ? " bracket" : ""}`}
                    title="Collapse pile"
                    onClick={(e) => {
                      e.stopPropagation();
                      void toggleStack(a);
                    }}
                  >
                    ▴ {a.burst_count}
                  </button>
                )}
                {stackExpanded &&
                  a.burst_id != null &&
                  sharpestByBurst.get(a.burst_id) === a.id && (
                    <span
                      className="sharpest-badge"
                      title="Sharpest frame of the pile (sharpness analysis)"
                    >
                      ◆
                    </span>
                  )}
                {!sel && frameIndex && (
                  <span className="frame-index-badge">
                    {frameIndex.rank}/{frameIndex.total}
                  </span>
                )}
                {sel && <span className="select-check">✓</span>}
              </div>
              );
            })}
          </div>
        )}

        {/* The loaded count reads under the grid it counts, not in the header:
            on a phone the header's right end sits under the fixed theme toggle
            and account chip, and the hint collided with them (UI review M1). */}
        {assets.length > 0 && (
          <p className="hint session-foot">{assets.length} loaded</p>
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
          renderInfo={(a) => <SimilarStrip assetId={a.id} />}
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

      {menu &&
        (() => {
          const target = assets.find((a) => a.id === menu.id);
          return (
            <AssetActionMenu
              x={menu.x}
              y={menu.y}
              label={target?.filename}
              pile={
                (target?.burst_count ?? 0) > 1
                  ? { count: target!.burst_count! }
                  : null
              }
              onAction={(action) => onMenuAction(menu.id, action)}
              onClose={() => setMenu(null)}
            />
          );
        })()}

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
          onApplied={(message, ids, source) =>
            geotagApplied(message, ids, geotag.loc!, source)
          }
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

// The line under the title (UI review H5): when, what shot it, how many files
// — the same sentence as the session card — then only the chips that carry a
// state: where the session lives (its root, opening to the full mount path on
// demand: the absolute path used to be the first and widest line of the page),
// previews pending or in error, the export state, and "ignored". The ready
// count and "✓ done" are gone — the bar in the toolbar says both.
function SessionMeta({ s }: { s: SessionInfo }) {
  const [pathOpen, setPathOpen] = useState(false);
  const pending = Number(s.pending_count) || 0;
  const errors = Number(s.error_count) || 0;
  const exportCount = Number(s.export_count) || 0;
  return (
    <>
      <div className="session-meta">
        <span>
          {formatCaptureSpan(s.captured_at_min, s.captured_at_max)} ·{" "}
          {s.device_hint ?? "unknown device"} · {s.asset_count}{" "}
          {s.asset_count === 1 ? "file" : "files"}
        </span>
        <button
          type="button"
          className={`pill session-path-chip${pathOpen ? " is-open" : ""}`}
          aria-expanded={pathOpen}
          title={pathOpen ? "Hide the folder path" : s.source_path}
          onClick={() => setPathOpen((o) => !o)}
        >
          {Icons.folder}
          {roleLabel(s.root_kind)}
          {Icons.chevronRight}
        </button>
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
        {s.ignored && (
          <span className="pill" title="Skipped as a whole; reactivate it from the ⋯ menu">
            ignored
          </span>
        )}
      </div>
      {pathOpen && (
        <div className="session-path" title="The folder on the NAS this session was indexed from">
          <code>{s.source_path}</code>
        </div>
      )}
    </>
  );
}

// The header's far end: one primary verb — the thing the session is waiting
// for — and the ⋯ menu with the rest (UI review H2/H5, the same rule as the
// session card). While frames are unrated the verb is to sift them, when the
// Sift section is on; the grid under this header is the fallback, so there is
// no "Sort N" here. Once sorting is done and there are picks nobody exported,
// the verb is Export. Anything else (exported, ignored, view-only, empty) has
// no primary. The six-button strip these replace put the trash beside the
// download and gave no verb more weight than another.
function SessionHeadActions({
  s,
  onIgnore,
  onExportPicks,
  onGeotag,
  onRestack,
  onDelete,
  onMessage,
}: {
  s: SessionInfo;
  onIgnore: () => void;
  onExportPicks: () => void;
  /** Set the capture location of the whole session (picker + recap flow). */
  onGeotag: () => void;
  /** Re-cluster the session's burst piles with the current thresholds. */
  onRestack: () => void;
  onDelete: () => void;
  /** Surface the Download menu's transient status to the page notice. */
  onMessage: (msg: string | null) => void;
}) {
  const features = useFeatures();
  const picks = Number(s.pick_count) || 0;
  const unrated = Number(s.unrated_count) || 0;
  const cullable = isCullable(s);

  let primary: ReactNode = null;
  if (!s.ignored && cullable) {
    if (unrated > 0) {
      if (features.sift) {
        primary = (
          <Link href={`/sift/${s.id}`} className="btn btn-primary page-primary">
            {Icons.sift} Sift {unrated} unrated
          </Link>
        );
      }
    } else if (picks > 0 && !s.exporting && !(Number(s.export_count) > 0)) {
      primary = (
        <button
          className="btn btn-primary page-primary"
          onClick={onExportPicks}
          title="Export the RAW picks to the Capture One export folder"
        >
          {Icons.upload} Export {picks} {picks === 1 ? "pick" : "picks"}
        </button>
      );
    }
  }

  return (
    <div className="page-actions">
      {primary}
      <SessionMenu
        ignored={s.ignored}
        canExport={picks > 0}
        onIgnore={onIgnore}
        onExportPicks={onExportPicks}
        onGeotag={onGeotag}
        onRestack={cullable ? onRestack : undefined}
        onDelete={onDelete}
        download={{
          zipHref: `/api/sessions/${s.id}/download`,
          zipName: `${s.name}.zip`,
          listFiles: () => sessionDownloadFiles(s.id),
          onMessage,
        }}
        deleteHint={
          cullable
            ? "Remove the session; its files can go with it"
            : "Remove the session from the database only"
        }
      />
    </div>
  );
}
