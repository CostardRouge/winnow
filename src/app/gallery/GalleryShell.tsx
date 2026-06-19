"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import VirtualGrid, { type GalleryAsset } from "./VirtualGrid";
import FilterPanel, {
  EMPTY_FILTERS,
  type Filters,
  type Facets,
} from "./FilterPanel";
import Tree, { type PathSeg } from "./Tree";
import { fetchJson } from "@/lib/fetchJson";
import { EmptyState, Icons } from "../ui";

// Coquille de galerie réutilisable, paramétrée par un `scope` (rôle de dossier) :
//   - scope absent      → toute la bibliothèque (route /gallery, power-user) ;
//   - scope="incoming"  → tri complet (rating, tags, sélection) ;
//   - scope="final"     → consultation seule (readOnly) : ni rating, ni export.
// `kind` (= scope) est injecté dans chaque appel (assets/facets/tree) MAIS n'est
// pas stocké dans Filters : « Reset » ne doit jamais effacer la portée d'onglet.

type Scope = "incoming" | "final";

type Row = GalleryAsset & {
  tags?: string[];
  camera_model?: string | null;
  lens?: string | null;
  iso?: number | null;
  shutter?: string | null;
  aperture?: number | null;
  focal_length?: number | null;
};

const MB = 1024 * 1024;

function toQuery(f: Filters, scope?: Scope, cursor?: string | null): string {
  const sp = new URLSearchParams();
  const arr = (k: string, a: (string | number)[]) =>
    a.length && sp.set(k, a.join(","));
  arr("media_type", f.media_type);
  arr("ext", f.ext);
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
  if (cursor) sp.set("cursor", cursor);
  return sp.toString();
}

// Applique le chemin d'un nœud d'arbre comme scope (réinitialise les dimensions
// d'arbre, conserve les autres filtres : verdict, tags, type…).
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

export default function GalleryShell({ scope }: { scope?: Scope }) {
  // Final = consultation seule : on masque tri/sélection/export.
  const readOnly = scope === "final";

  const [facets, setFacets] = useState<Facets | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [items, setItems] = useState<Row[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [viewer, setViewer] = useState<number | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [aside, setAside] = useState<"filters" | "browse">("filters");
  const [treeKey, setTreeKey] = useState("");
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [tagInput, setTagInput] = useState("");
  const [facetsError, setFacetsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadingRef = useRef(false);
  const filterKey = JSON.stringify(filters);

  const loadFacets = useCallback(() => {
    setFacetsError(null);
    fetchJson<Facets>(scope ? `/api/facets?kind=${scope}` : "/api/facets")
      .then(setFacets)
      .catch((e: Error) => {
        setFacets(null);
        setFacetsError(e.message);
      });
  }, [scope]);
  useEffect(() => loadFacets(), [loadFacets]);

  const fetchPage = useCallback(
    async (cur: string | null) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      setLoading(true);
      try {
        const data = await fetchJson<{
          assets?: Row[];
          next_cursor?: string | null;
        }>(`/api/assets?${toQuery(filters, scope, cur)}`);
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
    [filters, scope],
  );

  useEffect(() => {
    setItems([]);
    setCursor(null);
    setHasMore(true);
    fetchPage(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, scope]);

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

  // Navigation clavier dans la visionneuse.
  useEffect(() => {
    if (viewer == null) return;
    const onKey = (e: KeyboardEvent) => {
      const a = items[viewer];
      if (!a) return;
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === "Escape") return setViewer(null);
      if (e.key === "ArrowRight") return setViewer((v) => Math.min((v ?? 0) + 1, items.length - 1));
      if (e.key === "ArrowLeft") return setViewer((v) => Math.max((v ?? 0) - 1, 0));
      if (readOnly) return; // pas de notation en consultation seule
      if (e.key.toLowerCase() === "p") return void rate(a.id, { verdict: "pick" });
      if (e.key.toLowerCase() === "x") return void rate(a.id, { verdict: "reject" });
      if (e.key.toLowerCase() === "u") return void rate(a.id, { verdict: "unrated" });
      if (/^[0-5]$/.test(e.key)) return void rate(a.id, { star: Number(e.key) });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewer, items, rate, readOnly]);

  const a = viewer != null ? items[viewer] : null;

  return (
    <div className="gallery-shell">
      <div className="gallery-controls">
        <button className="btn gallery-filter-toggle" onClick={() => setPanelOpen((o) => !o)}>
          Panel
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
        <span className="spacer" />
        <span className="hint">
          {items.length}{hasMore ? "+" : ""} shown
          {facets ? ` · ${facets.total} total` : ""}
        </span>
      </div>

      {!readOnly && selectMode && (
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
          <span className="spacer" />
          <input
            className="input"
            placeholder="tag name"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            style={{ minWidth: 140 }}
          />
          <button
            className="btn btn-pick"
            disabled={!selected.size || !tagInput.trim()}
            onClick={() => assignTags([...selected], tagInput, true)}
          >
            + Add tag
          </button>
          <button
            className="btn btn-reject"
            disabled={!selected.size || !tagInput.trim()}
            onClick={() => assignTags([...selected], tagInput, false)}
          >
            − Remove
          </button>
        </div>
      )}

      <div className="gallery-body">
        <aside className={`gallery-aside${panelOpen ? " open" : ""}`}>
          <div className="chips" style={{ marginBottom: 10 }}>
            <button
              className={`chip${aside === "filters" ? " active" : ""}`}
              onClick={() => setAside("filters")}
            >
              Filters
            </button>
            <button
              className={`chip${aside === "browse" ? " active" : ""}`}
              onClick={() => setAside("browse")}
            >
              Browse
            </button>
          </div>

          {aside === "filters" ? (
            <>
              <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
                <button className="btn" onClick={() => setFilters(EMPTY_FILTERS)}>
                  Reset
                </button>
              </div>
              {facetsError ? (
                <div className="error-box">
                  <span>Couldn’t load filters: {facetsError}</span>
                  <button className="btn" onClick={loadFacets}>
                    Retry
                  </button>
                </div>
              ) : (
                <FilterPanel facets={facets} filters={filters} set={setFilters} />
              )}
            </>
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

        <main className="gallery-main">
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
              onOpen={setViewer}
              selectMode={!readOnly && selectMode}
              selectedIds={selected}
              onToggleSelect={toggleSelect}
            />
          )}
        </main>
      </div>

      {a && (
        <div className="viewer">
          <button className="close" onClick={() => setViewer(null)}>×</button>
          <div className="exif">
            <strong>{a.filename}</strong>
            <br />
            {a.camera_model ?? "?"} · {a.lens ?? "?"}
            <br />
            {a.focal_length ? `${a.focal_length}mm · ` : ""}
            {a.aperture ? `f/${a.aperture} · ` : ""}
            {a.shutter ? `${a.shutter}s · ` : ""}
            {a.iso ? `ISO ${a.iso}` : ""}
            <div className="viewer-tags">
              {(a.tags ?? []).map((t) => (
                <span key={t} className="chip active">
                  {t}
                  {!readOnly && (
                    <button
                      className="chip-x"
                      onClick={() => assignTags([a.id], t, false)}
                    >
                      ×
                    </button>
                  )}
                </span>
              ))}
              {!readOnly && (
                <input
                  className="input"
                  placeholder="+ tag"
                  style={{ width: 90, padding: "2px 8px" }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      assignTags([a.id], (e.target as HTMLInputElement).value, true);
                      (e.target as HTMLInputElement).value = "";
                    }
                  }}
                />
              )}
            </div>
          </div>
          <div className="stage">
            {a.derivative_status === "ready" ? (
              a.media_type === "video" ? (
                <video
                  key={a.id}
                  src={`/api/assets/${a.id}/proxy`}
                  poster={`/api/assets/${a.id}/thumb`}
                  controls
                  playsInline
                  autoPlay
                  muted
                  loop
                />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`/api/assets/${a.id}/proxy`} alt={a.filename} />
              )
            ) : (
              <div className="placeholder">Derivative unavailable</div>
            )}
          </div>
          <div className="controls">
            <button className="btn" onClick={() => setViewer((v) => Math.max((v ?? 0) - 1, 0))} disabled={viewer === 0}>←</button>
            {!readOnly && (
              <>
                <button
                  className={`btn ${a.verdict === "reject" ? "btn-reject" : ""}`}
                  onClick={() => rate(a.id, { verdict: "reject" })}
                >
                  ✕ Reject
                </button>
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    className="btn"
                    style={{ color: a.star >= n ? "var(--star)" : undefined }}
                    onClick={() => rate(a.id, { star: n })}
                  >
                    ★
                  </button>
                ))}
                <button
                  className={`btn ${a.verdict === "pick" ? "btn-pick" : ""}`}
                  onClick={() => rate(a.id, { verdict: "pick" })}
                >
                  ✓ Pick
                </button>
              </>
            )}
            <button
              className="btn"
              onClick={() => setViewer((v) => Math.min((v ?? 0) + 1, items.length - 1))}
              disabled={viewer === items.length - 1}
            >
              →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
