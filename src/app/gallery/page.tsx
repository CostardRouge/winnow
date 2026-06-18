"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import VirtualGrid, { type GalleryAsset } from "./VirtualGrid";
import FilterPanel, {
  EMPTY_FILTERS,
  type Filters,
  type Facets,
} from "./FilterPanel";

type Row = GalleryAsset & {
  camera_model?: string | null;
  lens?: string | null;
  iso?: number | null;
  shutter?: string | null;
  aperture?: number | null;
  focal_length?: number | null;
  width?: number | null;
  height?: number | null;
};

const MB = 1024 * 1024;

function toQuery(f: Filters, cursor?: string | null): string {
  const sp = new URLSearchParams();
  const arr = (k: string, a: (string | number)[]) =>
    a.length && sp.set(k, a.join(","));
  arr("media_type", f.media_type);
  arr("ext", f.ext);
  arr("device", f.device);
  arr("camera_model", f.camera_model);
  arr("lens", f.lens);
  arr("year", f.year);
  arr("month", f.month);
  arr("day", f.day);
  if (f.date_from) sp.set("date_from", f.date_from);
  if (f.date_to) sp.set("date_to", f.date_to);
  if (f.verdict) sp.set("verdict", f.verdict);
  if (f.star_min) sp.set("star_min", String(f.star_min));
  for (const k of [
    "iso_min",
    "iso_max",
    "focal_min",
    "focal_max",
    "aperture_min",
    "aperture_max",
  ] as const) {
    if (f[k] != null) sp.set(k, String(f[k]));
  }
  if (f.size_min != null) sp.set("size_min", String(Math.round(f.size_min * MB)));
  if (f.size_max != null) sp.set("size_max", String(Math.round(f.size_max * MB)));
  if (f.has_gps) sp.set("has_gps", "true");
  if (cursor) sp.set("cursor", cursor);
  return sp.toString();
}

export default function Gallery() {
  const [facets, setFacets] = useState<Facets | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [items, setItems] = useState<Row[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [viewer, setViewer] = useState<number | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const loadingRef = useRef(false);
  const filterKey = JSON.stringify(filters);

  useEffect(() => {
    fetch("/api/facets")
      .then((r) => r.json())
      .then(setFacets)
      .catch(() => setFacets(null));
  }, []);

  const fetchPage = useCallback(
    async (cur: string | null) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      setLoading(true);
      try {
        const r = await fetch(`/api/assets?${toQuery(filters, cur)}`);
        const data = await r.json();
        setItems((prev) => (cur ? [...prev, ...(data.assets ?? [])] : data.assets ?? []));
        setCursor(data.next_cursor);
        setHasMore(Boolean(data.next_cursor));
      } finally {
        setLoading(false);
        loadingRef.current = false;
      }
    },
    [filters],
  );

  // (Re)chargement à chaque changement de filtre.
  useEffect(() => {
    setItems([]);
    setCursor(null);
    setHasMore(true);
    fetchPage(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);

  const rate = useCallback(
    async (assetId: number, patch: { verdict?: Row["verdict"]; star?: number }) => {
      setItems((prev) =>
        prev.map((a) => (a.id === assetId ? { ...a, ...patch } : a)),
      );
      await fetch(`/api/assets/${assetId}/rating`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    },
    [],
  );

  useEffect(() => {
    if (viewer == null) return;
    const onKey = (e: KeyboardEvent) => {
      const a = items[viewer];
      if (!a) return;
      if (e.key === "Escape") return setViewer(null);
      if (e.key === "ArrowRight")
        return setViewer((v) => Math.min((v ?? 0) + 1, items.length - 1));
      if (e.key === "ArrowLeft") return setViewer((v) => Math.max((v ?? 0) - 1, 0));
      if (e.key.toLowerCase() === "p") return void rate(a.id, { verdict: "pick" });
      if (e.key.toLowerCase() === "x") return void rate(a.id, { verdict: "reject" });
      if (e.key.toLowerCase() === "u") return void rate(a.id, { verdict: "unrated" });
      if (/^[0-5]$/.test(e.key)) return void rate(a.id, { star: Number(e.key) });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewer, items, rate]);

  const a = viewer != null ? items[viewer] : null;

  return (
    <div className="gallery-layout">
      <div className="topbar">
        <Link href="/" className="btn">←</Link>
        <h1>Gallery</h1>
        <button
          className="btn gallery-filter-toggle"
          onClick={() => setPanelOpen((o) => !o)}
        >
          Filters
        </button>
        <span className="spacer" />
        <span className="hint">
          {items.length}
          {hasMore ? "+" : ""} shown
          {facets ? ` · ${facets.total} total` : ""}
        </span>
      </div>

      <div className="gallery-body">
        <aside className={`gallery-aside${panelOpen ? " open" : ""}`}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <strong>Filters</strong>
            <button className="btn" onClick={() => setFilters(EMPTY_FILTERS)}>
              Reset
            </button>
          </div>
          <FilterPanel facets={facets} filters={filters} set={setFilters} />
        </aside>

        <main className="gallery-main">
          {items.length === 0 && !loading ? (
            <div className="empty">No assets match these filters.</div>
          ) : (
            <VirtualGrid
              items={items}
              hasMore={hasMore}
              loading={loading}
              loadMore={() => fetchPage(cursor)}
              onOpen={setViewer}
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
          </div>
          <div className="stage">
            {a.derivative_status === "ready" ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={`/api/assets/${a.id}/proxy`} alt={a.filename} />
            ) : (
              <div className="placeholder">Derivative unavailable</div>
            )}
          </div>
          <div className="controls">
            <button
              className="btn"
              onClick={() => setViewer((v) => Math.max((v ?? 0) - 1, 0))}
              disabled={viewer === 0}
            >
              ←
            </button>
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
            <button
              className="btn"
              onClick={() =>
                setViewer((v) => Math.min((v ?? 0) + 1, items.length - 1))
              }
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
