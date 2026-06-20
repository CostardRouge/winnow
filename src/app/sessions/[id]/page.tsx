"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  use as usePromise,
} from "react";
import Link from "next/link";
import { fetchJson } from "@/lib/fetchJson";
import AssetActionMenu, {
  type AssetMenuAction,
} from "@/app/gallery/AssetActionMenu";
import { deleteAssets, exportAssets, tagAssets } from "@/lib/assetActions";
import { Icons } from "@/app/ui";

type Verdict = "pick" | "reject" | "unrated";
type AssetRow = {
  id: number;
  filename: string;
  media_type: "photo" | "video";
  derivative_status: string;
  captured_at: string | null;
  camera_model: string | null;
  lens: string | null;
  iso: number | null;
  shutter: string | null;
  aperture: number | null;
  focal_length: number | null;
  width: number | null;
  height: number | null;
  verdict: Verdict;
  star: number;
};

const VERDICT_FILTERS: Array<{ key: string; label: string }> = [
  { key: "", label: "All" },
  { key: "unrated", label: "Unrated" },
  { key: "pick", label: "Picks" },
  { key: "reject", label: "Rejects" },
];

export default function SessionGrid({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = usePromise(params);
  const [assets, setAssets] = useState<AssetRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verdict, setVerdict] = useState("");
  const [viewer, setViewer] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);

  // Transient confirmation ("Export queued", "Deleted") — auto-clears.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(t);
  }, [notice]);

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
        const data = await fetchJson<{
          assets?: AssetRow[];
          next_cursor?: string | null;
        }>(`/api/sessions/${id}/assets?${sp.toString()}`);
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
      await deleteAssets(ids);
      setNotice(ids.length > 1 ? `${ids.length} deleted` : "Deleted");
      return true;
    },
    [],
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

  const addTag = useCallback(async (id: number, name: string) => {
    if (!name.trim()) return;
    await tagAssets([id], name, true);
    setNotice(`Tagged “${name.trim()}”`);
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
          return void addTag(id, action.name);
        case "export":
          return void exportSelection([id]);
        case "delete":
          return void removeAssets([id]);
      }
    },
    [rate, addTag, exportSelection, removeAssets],
  );

  // Keyboard navigation in the viewer (desktop).
  useEffect(() => {
    if (viewer == null) return;
    const onKey = (e: KeyboardEvent) => {
      const a = assets[viewer];
      if (!a) return;
      if (e.key === "Escape") return setViewer(null);
      if (e.key === "ArrowRight")
        return setViewer((v) => Math.min((v ?? 0) + 1, assets.length - 1));
      if (e.key === "ArrowLeft")
        return setViewer((v) => Math.max((v ?? 0) - 1, 0));
      if (e.key.toLowerCase() === "p") return void rate(a.id, { verdict: "pick" });
      if (e.key.toLowerCase() === "x")
        return void rate(a.id, { verdict: "reject" });
      if (e.key.toLowerCase() === "u")
        return void rate(a.id, { verdict: "unrated" });
      if (/^[0-5]$/.test(e.key))
        return void rate(a.id, { star: Number.parseInt(e.key, 10) });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewer, assets, rate]);

  return (
    <>
      <div className="topbar">
        <Link href="/" className="btn btn-icon" aria-label="Back">
          {Icons.back}
        </Link>
        <h1>Session #{id}</h1>
        <span className="spacer" />
        {notice && <span className="notice">{notice}</span>}
        <span className="hint">{assets.length} loaded</span>
      </div>

      <div className="container">
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
                {a.media_type === "video" && (
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
              </div>
            ))}
          </div>
        )}

        <div ref={sentinel} style={{ height: 40 }} />
        {loading && <div className="spinner">Loading…</div>}
      </div>

      {viewer != null && assets[viewer] && (
        <Viewer
          asset={assets[viewer]}
          hasPrev={viewer > 0}
          hasNext={viewer < assets.length - 1}
          onClose={() => setViewer(null)}
          onPrev={() => setViewer((v) => Math.max((v ?? 0) - 1, 0))}
          onNext={() =>
            setViewer((v) => Math.min((v ?? 0) + 1, assets.length - 1))
          }
          onRate={(patch) => rate(assets[viewer].id, patch)}
          onExport={() => exportSelection([assets[viewer].id])}
          onDelete={async () => {
            if (await removeAssets([assets[viewer].id])) setViewer(null);
          }}
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
    </>
  );
}

function Viewer({
  asset,
  hasPrev,
  hasNext,
  onClose,
  onPrev,
  onNext,
  onRate,
  onExport,
  onDelete,
}: {
  asset: AssetRow;
  hasPrev: boolean;
  hasNext: boolean;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  onRate: (patch: { verdict?: Verdict; star?: number }) => void;
  onExport: () => void;
  onDelete: () => void;
}) {
  const touch = useRef<{ x: number; y: number } | null>(null);

  function onTouchStart(e: React.TouchEvent) {
    const t = e.touches[0];
    touch.current = { x: t.clientX, y: t.clientY };
  }
  function onTouchEnd(e: React.TouchEvent) {
    if (!touch.current) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touch.current.x;
    const dy = t.clientY - touch.current.y;
    touch.current = null;
    const TH = 60;
    if (Math.abs(dx) > Math.abs(dy)) {
      // Horizontal: navigation.
      if (dx > TH && hasPrev) onPrev();
      else if (dx < -TH && hasNext) onNext();
    } else {
      // Vertical: culling (swipe up = pick, down = reject).
      if (dy < -TH) onRate({ verdict: "pick" });
      else if (dy > TH) onRate({ verdict: "reject" });
    }
  }

  return (
    <div className="viewer" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      <button className="close" onClick={onClose}>
        ×
      </button>
      <div className="exif">
        <strong>{asset.filename}</strong>
        <br />
        {asset.camera_model ?? "?"} · {asset.lens ?? "?"}
        <br />
        {asset.focal_length ? `${asset.focal_length}mm · ` : ""}
        {asset.aperture ? `f/${asset.aperture} · ` : ""}
        {asset.shutter ? `${asset.shutter}s · ` : ""}
        {asset.iso ? `ISO ${asset.iso}` : ""}
        <br />
        {asset.width && asset.height
          ? `${asset.width}×${asset.height}`
          : ""}{" "}
        {asset.star > 0 ? "★".repeat(asset.star) : ""}
      </div>
      <div className="stage">
        {asset.derivative_status === "ready" ? (
          asset.media_type === "video" ? (
            <video
              key={asset.id}
              src={`/api/assets/${asset.id}/proxy`}
              poster={`/api/assets/${asset.id}/thumb`}
              controls
              playsInline
              autoPlay
              muted
              loop
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`/api/assets/${asset.id}/proxy`} alt={asset.filename} />
          )
        ) : (
          <div className="placeholder">Derivative unavailable</div>
        )}
      </div>
      <div className="controls">
        <button className="btn" onClick={onPrev} disabled={!hasPrev}>
          ←
        </button>
        <button
          className={`btn ${asset.verdict === "reject" ? "btn-reject" : ""}`}
          onClick={() => onRate({ verdict: "reject" })}
        >
          ✕ Reject
        </button>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            className="btn"
            style={{ color: asset.star >= n ? "var(--star)" : undefined }}
            onClick={() => onRate({ star: n })}
          >
            ★
          </button>
        ))}
        <button
          className={`btn ${asset.verdict === "pick" ? "btn-pick" : ""}`}
          onClick={() => onRate({ verdict: "pick" })}
        >
          ✓ Pick
        </button>
        <button className="btn" onClick={onExport}>
          ⤓ Export
        </button>
        <button className="btn btn-reject" onClick={onDelete}>
          🗑 Delete
        </button>
        <button className="btn" onClick={onNext} disabled={!hasNext}>
          →
        </button>
      </div>
    </div>
  );
}
