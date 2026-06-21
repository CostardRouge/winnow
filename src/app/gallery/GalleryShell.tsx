"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import VirtualGrid, { type GalleryAsset } from "./VirtualGrid";
import type { Bbox, GeoPoint } from "./MapView";
import FilterPanel, {
  EMPTY_FILTERS,
  type Filters,
  type Facets,
} from "./FilterPanel";
import Tree, { type PathSeg } from "./Tree";
import AssetActionMenu, { type AssetMenuAction } from "./AssetActionMenu";
import { ViewSegments, type SectionView, type ViewContext } from "./ViewSwitch";
import MediaViewer from "../MediaViewer";
import ViewerActions from "../ViewerActions";
import { fetchJson } from "@/lib/fetchJson";
import {
  deleteAssets,
  exportAssets,
  rateAssets,
  regenerateAssets,
} from "@/lib/assetActions";
import { EmptyState, Icons } from "../ui";

// Reusable gallery shell, parameterized by a `scope` (folder role):
//   - no scope          → the whole library (route /gallery, power-user);
//   - scope="incoming"  → full culling (rating, tags, selection);
//   - scope="final"     → read-only (readOnly): no rating, no export.
// `kind` (= scope) is injected into every call (assets/facets/tree) BUT is not
// stored in Filters: "Reset" must never clear the tab scope.
//
// The section's views (Grid, Map, plus any `extraViews` such as Sessions) live
// in a single segmented control; the active view contributes its own toolbar
// modifier. Built-in Grid/Map are `usesGalleryData` views — the filter-driven
// dataset is fetched lazily, only while one of them is active.

type Scope = "incoming" | "final";

type Row = GalleryAsset & {
  tags?: string[];
  camera_model?: string | null;
  lens?: string | null;
  iso?: number | null;
  shutter?: string | null;
  aperture?: number | null;
  focal_length?: number | null;
  captured_at?: string | null;
  file_mtime?: string | null;
  width?: number | null;
  height?: number | null;
  duration_s?: number | null;
  device?: string | null;
  gps?: { lat: number; lon: number } | null;
  rel_path?: string | null;
  // Pairing: the companion of this displayed primary, its group kind and the
  // companion's per-file stats, fed to the grid badge and the viewer's segmented
  // toggle (cf. lib/pairing.ts) — the stats let the viewer describe the companion
  // side when it's on screen.
  companion_id?: number | null;
  companion_ext?: string | null;
  companion_media_type?: "photo" | "video" | null;
  companion_filename?: string | null;
  companion_file_size?: number | null;
  companion_width?: number | null;
  companion_height?: number | null;
  group_kind?: "raw_jpeg" | "live_photo" | null;
};

// Leaflet touches `window` on import, so the map is client-only (no SSR).
const MapView = dynamic(() => import("./MapView"), {
  ssr: false,
  loading: () => <div className="map-loading">Loading map…</div>,
});

const MB = 1024 * 1024;

// Grid density presets (target cell width in px). Fewer/larger ↔ more/smaller
// media per line. The responsive engine derives the actual column count from
// the container width, so these stay sensible on both desktop and mobile.
const GRID_SIZES = [
  { w: 260, label: "Large" },
  { w: 175, label: "Medium" },
  { w: 110, label: "Small" },
] as const;
const GRID_SIZE_KEY = "winnow.grid.size";
const GRID_SIZE_DEFAULT = 1; // Medium

function toQuery(
  f: Filters,
  scope?: Scope,
  cursor?: string | null,
  opts?: { skipBbox?: boolean },
): string {
  const sp = new URLSearchParams();
  const arr = (k: string, a: (string | number)[]) =>
    a.length && sp.set(k, a.join(","));
  if (f.q) sp.set("q", f.q);
  arr("media_type", f.media_type);
  arr("ext", f.ext);
  arr("derivative_status", f.derivative_status);
  arr("not_derivative_status", f.not_derivative_status);
  arr("device", f.device);
  arr("camera_model", f.camera_model);
  arr("lens", f.lens);
  arr("tags", f.tags);
  arr("year", f.year);
  arr("month", f.month);
  arr("day", f.day);
  if (scope) sp.set("kind", scope);
  if (f.root_id != null) sp.set("root_id", String(f.root_id));
  if (f.session_id != null) sp.set("session_id", String(f.session_id));
  if (f.date_from) sp.set("date_from", f.date_from);
  if (f.date_to) sp.set("date_to", f.date_to);
  if (f.verdict) sp.set("verdict", f.verdict);
  if (f.star_min) sp.set("star_min", String(f.star_min));
  for (const k of [
    "iso_min", "iso_max", "focal_min", "focal_max", "aperture_min", "aperture_max",
  ] as const) {
    if (f[k] != null) sp.set(k, String(f[k]));
  }
  if (f.size_min != null) sp.set("size_min", String(Math.round(f.size_min * MB)));
  if (f.size_max != null) sp.set("size_max", String(Math.round(f.size_max * MB)));
  if (f.has_gps) sp.set("has_gps", "true");
  // Session-grid status toggles (ignored/completed are hidden by default).
  if (f.show_ignored) sp.set("show_ignored", "true");
  if (f.show_completed) sp.set("show_completed", "true");
  if (f.bbox && !opts?.skipBbox) sp.set("bbox", f.bbox.join(","));
  if (cursor) sp.set("cursor", cursor);
  return sp.toString();
}

// Applies a tree node's path as scope (resets the tree dimensions, keeps the
// other filters: verdict, tags, type...).
function applyScope(prev: Filters, path: PathSeg[]): Filters {
  const base: Filters = {
    ...prev,
    year: [], month: [], day: [], device: [],
    root_id: undefined, session_id: undefined,
  };
  for (const s of path) {
    if (s.key === "year") base.year = [Number(s.value)];
    else if (s.key === "month") base.month = [Number(s.value)];
    else if (s.key === "day") base.day = [Number(s.value)];
    else if (s.key === "device") base.device = [String(s.value)];
    else if (s.key === "root_id") base.root_id = Number(s.value);
    else if (s.key === "session_id") base.session_id = Number(s.value);
  }
  return base;
}

export default function GalleryShell({
  scope,
  extraViews,
  defaultView,
  view: controlledView,
  onSelectView,
  initialFilters,
  onFiltersChange,
}: {
  scope?: Scope;
  /** Extra section views (e.g. Sessions) shown before the built-in Grid/Map. */
  extraViews?: SectionView[];
  /** Id of the view selected on mount (defaults to "grid"). */
  defaultView?: string;
  /** Route-controlled active view; falls back to internal state when absent
   *  (so /gallery keeps working without URL plumbing). */
  view?: string;
  /** Navigate when a view segment is chosen (route-controlled mode). */
  onSelectView?: (id: string) => void;
  /** Seed filters once on mount, e.g. parsed from the URL. */
  initialFilters?: Filters;
  /** Notified whenever filters change, so the host can mirror them to the URL. */
  onFiltersChange?: (f: Filters) => void;
}) {
  // Final = read-only: hide culling/selection/export.
  const readOnly = scope === "final";

  const [facets, setFacets] = useState<Facets | null>(null);
  const [filters, setFilters] = useState<Filters>(initialFilters ?? EMPTY_FILTERS);
  const [items, setItems] = useState<Row[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [viewer, setViewer] = useState<number | null>(null);
  // The active view is route-controlled when `view`/`onSelectView` are supplied
  // (Library), otherwise held internally (the standalone /gallery).
  const [internalView, setInternalView] = useState<string>(defaultView ?? "grid");
  const view = controlledView ?? internalView;
  const selectView = onSelectView ?? setInternalView;
  // Grid feed ordering (capture timeline) + thumbnail density. Newest-first by
  // default; density restored from localStorage so it sticks between visits.
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");
  const [gridSize, setGridSize] = useState(GRID_SIZE_DEFAULT);
  const [geoPoints, setGeoPoints] = useState<GeoPoint[]>([]);
  const [geoTruncated, setGeoTruncated] = useState(false);
  const [geoLoading, setGeoLoading] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [aside, setAside] = useState<"filters" | "browse">("filters");
  const [treeKey, setTreeKey] = useState("");
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [tagInput, setTagInput] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; id: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [facetsError, setFacetsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadingRef = useRef(false);
  const filterKey = JSON.stringify(filters);

  // Built-in views backed by the filter-driven dataset. Anything else (an
  // injected view such as Sessions) renders without touching the gallery feed.
  const galleryActive = view === "grid" || view === "map";

  // Restore / persist the grid density choice (client-only, avoids SSR drift).
  useEffect(() => {
    const saved = Number(localStorage.getItem(GRID_SIZE_KEY));
    if (Number.isInteger(saved) && saved >= 0 && saved < GRID_SIZES.length)
      setGridSize(saved);
  }, []);
  useEffect(() => {
    localStorage.setItem(GRID_SIZE_KEY, String(gridSize));
  }, [gridSize]);

  // Mirror filter changes back to the host (which writes them to the URL). Skip
  // the first run so we don't immediately rewrite the URL we just seeded from.
  const firstFilterSync = useRef(true);
  useEffect(() => {
    if (firstFilterSync.current) {
      firstFilterSync.current = false;
      return;
    }
    onFiltersChange?.(filters);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);

  // Transient confirmation ("Export queued", "3 deleted") — auto-clears.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(t);
  }, [notice]);

  const loadFacets = useCallback(() => {
    setFacetsError(null);
    fetchJson<Facets>(scope ? `/api/facets?kind=${scope}` : "/api/facets")
      .then(setFacets)
      .catch((e: Error) => {
        setFacets(null);
        setFacetsError(e.message);
      });
  }, [scope]);
  // Facets feed the Filters panel, which is now available to the Sessions view
  // too — so load them up front (memoized per scope), not only for Grid/Map.
  useEffect(() => {
    loadFacets();
  }, [loadFacets]);

  const fetchPage = useCallback(
    async (cur: string | null) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      setLoading(true);
      try {
        // collapse=1: RAW+JPEG pairs show as one tile (the JPEG/HEIF primary);
        // the RAW companion rides along on the row for the badge + viewer toggle.
        const data = await fetchJson<{
          assets?: Row[];
          next_cursor?: string | null;
        }>(
          `/api/assets?${toQuery(filters, scope, cur)}&sort_dir=${sortDir}&collapse=1`,
        );
        setError(null);
        setItems((prev) => (cur ? [...prev, ...(data.assets ?? [])] : data.assets ?? []));
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
    [filters, scope, sortDir],
  );

  useEffect(() => {
    if (!galleryActive) return;
    setItems([]);
    setCursor(null);
    setHasMore(true);
    fetchPage(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, scope, galleryActive, sortDir]);

  // Map points: the full geotagged distribution for the current filters
  // (the zone/bbox is chosen ON the map, so it's excluded from this query).
  const geoQuery = toQuery(filters, scope, null, { skipBbox: true });
  useEffect(() => {
    if (view !== "map") return;
    let cancelled = false;
    setGeoLoading(true);
    fetchJson<{ points?: GeoPoint[]; truncated?: boolean }>(
      `/api/assets/geo?${geoQuery}`,
    )
      .then((d) => {
        if (cancelled) return;
        setGeoPoints(d.points ?? []);
        setGeoTruncated(Boolean(d.truncated));
      })
      .catch(() => {
        if (!cancelled) {
          setGeoPoints([]);
          setGeoTruncated(false);
        }
      })
      .finally(() => !cancelled && setGeoLoading(false));
    return () => {
      cancelled = true;
    };
  }, [view, geoQuery]);

  const rate = useCallback(
    async (assetId: number, patch: { verdict?: Row["verdict"]; star?: number }) => {
      if (readOnly) return;
      setItems((prev) => prev.map((a) => (a.id === assetId ? { ...a, ...patch } : a)));
      await fetch(`/api/assets/${assetId}/rating`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    },
    [readOnly],
  );

  // --- Tags ----------------------------------------------------------------
  const assignTags = useCallback(
    async (ids: number[], name: string, add: boolean) => {
      if (readOnly || !ids.length || !name.trim()) return;
      const tag = name.trim();
      await fetch("/api/tags/assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, [add ? "add" : "remove"]: [tag] }),
      });
      const idset = new Set(ids);
      setItems((prev) =>
        prev.map((it) =>
          idset.has(it.id)
            ? {
                ...it,
                tags: add
                  ? Array.from(new Set([...(it.tags ?? []), tag])).sort()
                  : (it.tags ?? []).filter((t) => t !== tag),
              }
            : it,
        ),
      );
      loadFacets();
    },
    [loadFacets, readOnly],
  );

  const toggleSelect = useCallback((id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  // --- Rate / delete / export (one or many) --------------------------------
  // Verdict/stars on a set of ids (single = [id]), optimistic + bulk endpoint.
  const rateMany = useCallback(
    async (ids: number[], patch: { verdict?: Row["verdict"]; star?: number }) => {
      if (readOnly || !ids.length) return;
      const idset = new Set(ids);
      setItems((prev) => prev.map((a) => (idset.has(a.id) ? { ...a, ...patch } : a)));
      await rateAssets(ids, patch);
    },
    [readOnly],
  );

  // Soft delete (hidden from the library, original untouched). Returns whether
  // it actually ran (false if the confirm was dismissed).
  const removeAssets = useCallback(
    async (ids: number[]): Promise<boolean> => {
      if (readOnly || !ids.length) return false;
      const msg =
        ids.length > 1
          ? `Delete ${ids.length} assets? They’ll be hidden from the library — the originals are untouched.`
          : "Delete this asset? It’ll be hidden from the library — the original is untouched.";
      if (!window.confirm(msg)) return false;
      const idset = new Set(ids);
      setItems((prev) => prev.filter((a) => !idset.has(a.id)));
      setSelected((prev) => {
        const next = new Set(prev);
        ids.forEach((i) => next.delete(i));
        return next;
      });
      await deleteAssets(ids);
      setNotice(ids.length > 1 ? `${ids.length} deleted` : "Deleted");
      loadFacets();
      return true;
    },
    [readOnly, loadFacets],
  );

  // Queues a RAW-copy export job for exactly these ids.
  const exportSelection = useCallback(async (ids: number[]) => {
    if (!ids.length) return;
    try {
      const jobId = await exportAssets(ids);
      setNotice(`Export queued (#${jobId})`);
    } catch (e) {
      setNotice((e as Error).message);
    }
  }, []);

  // Rebuilds the thumb + proxy for these ids. Optimistically flips the grid
  // cells back to "pending" so the spinner shows until the worker is done.
  const regenerateSelection = useCallback(async (ids: number[]) => {
    if (!ids.length) return;
    const idset = new Set(ids);
    setItems((prev) =>
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

  // --- Map zone (bbox) actions ---------------------------------------------
  // The map hands back the ids inside the drawn/visible zone; pick & reject
  // reuse the bulk rating path, export reuses the selection export.
  const pickArea = useCallback(
    (ids: number[]) => {
      if (!ids.length) return;
      void rateMany(ids, { verdict: "pick" });
      setNotice(`${ids.length} picked`);
    },
    [rateMany],
  );
  const rejectArea = useCallback(
    (ids: number[]) => {
      if (!ids.length) return;
      void rateMany(ids, { verdict: "reject" });
      setNotice(`${ids.length} rejected`);
    },
    [rateMany],
  );
  // Apply the zone as a bbox filter and drop back to the grid to review it.
  const showAreaInGrid = useCallback(
    (bbox: Bbox) => {
      setFilters((prev) => ({ ...prev, bbox: [bbox.w, bbox.s, bbox.e, bbox.n] }));
      selectView("grid");
    },
    [selectView],
  );
  const clearBbox = useCallback(() => {
    setFilters((prev) => {
      if (!prev.bbox) return prev;
      const { bbox: _drop, ...rest } = prev;
      return rest;
    });
  }, []);

  // Dispatch a context-menu action onto a single asset.
  const onMenuAction = useCallback(
    (id: number, action: AssetMenuAction) => {
      switch (action.kind) {
        case "verdict":
          return void rate(id, { verdict: action.verdict });
        case "star":
          return void rate(id, { star: action.star });
        case "tag":
          return void assignTags([id], action.name, true);
        case "export":
          return void exportSelection([id]);
        case "regenerate":
          return void regenerateSelection([id]);
        case "delete":
          return void removeAssets([id]);
      }
    },
    [rate, assignTags, exportSelection, regenerateSelection, removeAssets],
  );

  // Rating shortcuts inside the viewer (p/x/u + 0–5). Navigation and
  // Escape-to-close are handled by MediaViewer itself.
  const onViewerKey = useCallback(
    (e: KeyboardEvent, it: Row) => {
      if (readOnly) return;
      if (e.key.toLowerCase() === "p") return void rate(it.id, { verdict: "pick" });
      if (e.key.toLowerCase() === "x") return void rate(it.id, { verdict: "reject" });
      if (e.key.toLowerCase() === "u") return void rate(it.id, { verdict: "unrated" });
      if (/^[0-5]$/.test(e.key)) return void rate(it.id, { star: Number(e.key) });
    },
    [rate, readOnly],
  );

  // The shared Filters/Browse aside, available to every filter-aware view
  // (the built-in Grid/Map and any injected view such as Sessions).
  const renderAside = () => (
    <aside className={`gallery-aside${panelOpen ? " open" : ""}`}>
      <div className="aside-head">
        <div className="view-toggle" role="group" aria-label="Panel section">
          <button
            className={`view-btn${aside === "filters" ? " active" : ""}`}
            onClick={() => setAside("filters")}
            aria-pressed={aside === "filters"}
          >
            Filters
          </button>
          <button
            className={`view-btn${aside === "browse" ? " active" : ""}`}
            onClick={() => setAside("browse")}
            aria-pressed={aside === "browse"}
          >
            Browse
          </button>
        </div>
        <button
          className="chip aside-reset"
          onClick={() => {
            setFilters(EMPTY_FILTERS);
            setTreeKey("");
          }}
          title="Reset all filters"
        >
          {Icons.reset} Reset
        </button>
      </div>

      {aside === "filters" ? (
        facetsError ? (
          <div className="error-box">
            <span>Couldn’t load filters: {facetsError}</span>
            <button className="btn" onClick={loadFacets}>
              Retry
            </button>
          </div>
        ) : (
          <FilterPanel
            facets={facets}
            filters={filters}
            set={setFilters}
            showSessionStatus={view === "sessions"}
          />
        )
      ) : (
        <Tree
          activeKey={treeKey}
          scope={scope}
          onScope={(path) => {
            setTreeKey(path.map((s) => `${s.key}:${s.value}`).join("/"));
            setFilters((prev) => applyScope(prev, path));
          }}
        />
      )}
    </aside>
  );

  // The filter-driven main for the built-in Grid/Map views.
  const renderGalleryMain = (mode: "grid" | "map") => (
    <main className="gallery-main">
      {mode === "map" ? (
          <MapView
            points={geoPoints}
            truncated={geoTruncated}
            loading={geoLoading}
            readOnly={readOnly}
            onPickArea={pickArea}
            onRejectArea={rejectArea}
            onExportArea={exportSelection}
            onShowInGrid={(bbox) => showAreaInGrid(bbox)}
          />
        ) : (
          <>
            {error && (
              <div className="error-box">
                <span>Couldn’t load assets: {error}</span>
                <button className="btn" onClick={() => fetchPage(null)}>
                  Retry
                </button>
              </div>
            )}
            {items.length === 0 && !loading && !error ? (
              <EmptyState
                icon={Icons.photos}
                title="No assets match these filters"
                hint="Loosen or clear a filter in the panel to see more of the library."
              />
            ) : (
              <VirtualGrid
                items={items}
                hasMore={hasMore}
                loading={loading}
                loadMore={() => fetchPage(cursor)}
                targetWidth={GRID_SIZES[gridSize].w}
                onOpen={setViewer}
                selectMode={!readOnly && selectMode}
                selectedIds={selected}
                onToggleSelect={toggleSelect}
                onContextMenu={
                  readOnly
                    ? undefined
                    : (e, asset) => {
                        e.preventDefault();
                        setMenu({ x: e.clientX, y: e.clientY, id: asset.id });
                      }
                }
              />
            )}
          </>
        )}
      </main>
  );

  // Built-in views. Grid carries the Select toggle as its modifier; Map none.
  // Any `extraViews` (e.g. Sessions) ride before them in the segmented control.
  const gridView: SectionView = {
    id: "grid",
    label: "Grid",
    usesGalleryData: true,
    controls: (
      <>
        <button
          className="btn"
          onClick={() => setSortDir((d) => (d === "desc" ? "asc" : "desc"))}
          aria-label={
            sortDir === "desc"
              ? "Newest first (tap for oldest)"
              : "Oldest first (tap for newest)"
          }
          title={sortDir === "desc" ? "Newest first" : "Oldest first"}
        >
          {sortDir === "desc" ? Icons.arrowDown : Icons.arrowUp}
          <span className="max-sm:hidden">
            {sortDir === "desc" ? "Newest" : "Oldest"}
          </span>
        </button>
        <button
          className="btn"
          onClick={() => setGridSize((s) => (s + 1) % GRID_SIZES.length)}
          aria-label={`Thumbnail size: ${GRID_SIZES[gridSize].label} (tap to change)`}
          title={`Thumbnail size: ${GRID_SIZES[gridSize].label}`}
        >
          {Icons.gridSize}
          <span className="max-sm:hidden">{GRID_SIZES[gridSize].label}</span>
        </button>
        {!readOnly && (
          <button
            className={`btn${selectMode ? " btn-primary" : ""}`}
            onClick={() => {
              setSelectMode((m) => !m);
              setSelected(new Set());
            }}
          >
            {selectMode ? "Done" : "Select"}
          </button>
        )}
      </>
    ),
    render: () => renderGalleryMain("grid"),
  };
  const mapView: SectionView = {
    id: "map",
    label: "Map",
    usesGalleryData: true,
    render: () => renderGalleryMain("map"),
  };
  const views: SectionView[] = [...(extraViews ?? []), gridView, mapView];
  const current = views.find((v) => v.id === view) ?? views[0];

  // Any view that shows the shared Filters/Browse aside (Grid, Map, Sessions).
  const showAside = Boolean(current.usesGalleryData || current.usesFilters);
  const viewCtx: ViewContext = { query: toQuery(filters, scope) };

  return (
    <div className="gallery-shell">
      <div className="gallery-controls">
        <ViewSegments views={views} active={current.id} onSelect={selectView} />
        {current.controls}
        {showAside && (
          <button
            className="btn gallery-filter-toggle"
            onClick={() => setPanelOpen((o) => !o)}
            aria-label="Toggle filters panel"
          >
            {Icons.panelLeft} Panel
          </button>
        )}
        {galleryActive && filters.bbox && (
          <button className="chip active" onClick={clearBbox} title="Clear the map zone filter">
            Zone ✕
          </button>
        )}
        <span className="spacer" />
        {notice && <span className="notice">{notice}</span>}
        {galleryActive && (
          <span className="hint">
            {items.length}{hasMore ? "+" : ""} shown
            {facets ? ` · ${facets.total} total` : ""}
          </span>
        )}
      </div>

      {!readOnly && selectMode && view === "grid" && (
        <div className="selectbar">
          <span className="hint">{selected.size} selected</span>
          <button
            className="btn"
            onClick={() => setSelected(new Set(items.map((i) => i.id)))}
          >
            Select all loaded
          </button>
          <button className="btn" onClick={() => setSelected(new Set())}>
            Clear
          </button>
          <span className="ctx-sep-v" />
          <button
            className="btn btn-pick"
            disabled={!selected.size}
            onClick={() => rateMany([...selected], { verdict: "pick" })}
          >
            ✓ Pick
          </button>
          <button
            className="btn btn-reject"
            disabled={!selected.size}
            onClick={() => rateMany([...selected], { verdict: "reject" })}
          >
            ✕ Reject
          </button>
          <span className="bulk-stars" role="group" aria-label="Rate selection">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                className="btn bulk-star"
                disabled={!selected.size}
                title={`${n} star${n > 1 ? "s" : ""}`}
                onClick={() => rateMany([...selected], { star: n })}
              >
                ★
              </button>
            ))}
          </span>
          <span className="spacer" />
          <input
            className="input"
            placeholder="tag name"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            style={{ minWidth: 120 }}
          />
          <button
            className="btn"
            disabled={!selected.size || !tagInput.trim()}
            onClick={() => assignTags([...selected], tagInput, true)}
          >
            + Tag
          </button>
          <button
            className="btn"
            disabled={!selected.size || !tagInput.trim()}
            onClick={() => assignTags([...selected], tagInput, false)}
          >
            − Tag
          </button>
          <span className="ctx-sep-v" />
          <button
            className="btn"
            disabled={!selected.size}
            onClick={() => exportSelection([...selected])}
          >
            ⤓ Export
          </button>
          <button
            className="btn"
            disabled={!selected.size}
            title="Rebuild thumbnail + proxy"
            onClick={() => regenerateSelection([...selected])}
          >
            ↻ Regenerate
          </button>
          <button
            className="btn btn-reject"
            disabled={!selected.size}
            onClick={() => removeAssets([...selected])}
          >
            🗑 Delete
          </button>
        </div>
      )}

      {showAside ? (
        <div className="gallery-body">
          {/* Mobile: tap the content area (outside the panel) to dismiss it. */}
          {panelOpen && (
            <div
              className="gallery-aside-backdrop"
              onClick={() => setPanelOpen(false)}
              aria-hidden
            />
          )}
          {renderAside()}
          {current.render(viewCtx)}
        </div>
      ) : (
        current.render(viewCtx)
      )}

      {viewer != null && items[viewer] && (
        <MediaViewer
          items={items}
          index={viewer}
          onIndexChange={setViewer}
          onClose={() => setViewer(null)}
          onKeyDown={onViewerKey}
          onContextMenu={
            readOnly
              ? undefined
              : (e, it) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, id: it.id });
                }
          }
          renderInfo={(it) =>
            (it.tags ?? []).length || !readOnly ? (
              <div className="viewer-tags">
                {(it.tags ?? []).map((t) => (
                  <span key={t} className="chip active">
                    {t}
                    {!readOnly && (
                      <button
                        className="chip-x"
                        onClick={() => assignTags([it.id], t, false)}
                      >
                        ×
                      </button>
                    )}
                  </span>
                ))}
              </div>
            ) : null
          }
          renderActions={
            readOnly
              ? undefined
              : (it) => (
                  <ViewerActions
                    verdict={it.verdict}
                    star={it.star}
                    onVerdict={(verdict) => rate(it.id, { verdict })}
                    onStar={(star) => rate(it.id, { star })}
                    onTag={(name) => assignTags([it.id], name, true)}
                    onExport={() => exportSelection([it.id])}
                    onRegenerate={() => regenerateSelection([it.id])}
                    onDelete={async () => {
                      if (await removeAssets([it.id])) {
                        // Keep the viewer open on the previous item rather than
                        // closing it; only bail out if nothing is left.
                        setViewer((cur) => {
                          if (cur == null) return null;
                          const remaining = items.length - 1;
                          return remaining > 0
                            ? Math.min(Math.max(cur - 1, 0), remaining - 1)
                            : null;
                        });
                      }
                    }}
                  />
                )
          }
        />
      )}

      {menu && (
        <AssetActionMenu
          x={menu.x}
          y={menu.y}
          label={items.find((i) => i.id === menu.id)?.filename}
          onAction={(action) => onMenuAction(menu.id, action)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
