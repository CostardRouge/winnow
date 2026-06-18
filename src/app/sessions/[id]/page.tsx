"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  use as usePromise,
} from "react";
import Link from "next/link";

type Verdict = "pick" | "reject" | "unrated";
type AssetRow = {
  id: number;
  filename: string;
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
  { key: "", label: "Tout" },
  { key: "unrated", label: "Non triés" },
  { key: "pick", label: "Picks" },
  { key: "reject", label: "Rejets" },
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
  const [verdict, setVerdict] = useState("");
  const [viewer, setViewer] = useState<number | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);

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
        const r = await fetch(`/api/sessions/${id}/assets?${sp.toString()}`);
        const data = await r.json();
        setAssets((prev) => (cur ? [...prev, ...data.assets] : data.assets));
        setCursor(data.next_cursor);
        setHasMore(Boolean(data.next_cursor));
      } finally {
        setLoading(false);
        loadingRef.current = false;
      }
    },
    [id, verdict],
  );

  // (Re)chargement initial à chaque changement de filtre.
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

  // Navigation clavier dans la visionneuse (desktop).
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
        <Link href="/" className="btn">
          ←
        </Link>
        <h1>Session #{id}</h1>
        <span className="spacer" />
        <span className="hint">{assets.length} chargés</span>
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
            Clavier : P pick · X rejet · U annuler · 1-5 étoiles · ←/→
          </span>
        </div>

        {assets.length === 0 && !loading ? (
          <div className="empty">Aucun asset pour ce filtre.</div>
        ) : (
          <div className="grid">
            {assets.map((a, i) => (
              <div
                key={a.id}
                className={`cell ${a.verdict}`}
                onClick={() => setViewer(i)}
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
                      ? "⚠ erreur"
                      : a.derivative_status === "skipped"
                        ? a.filename
                        : "⏳ dérivé…"}
                  </div>
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
        {loading && <div className="spinner">Chargement…</div>}
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
}: {
  asset: AssetRow;
  hasPrev: boolean;
  hasNext: boolean;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  onRate: (patch: { verdict?: Verdict; star?: number }) => void;
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
      // Horizontal : navigation.
      if (dx > TH && hasPrev) onPrev();
      else if (dx < -TH && hasNext) onNext();
    } else {
      // Vertical : tri (swipe haut = pick, bas = rejet).
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
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`/api/assets/${asset.id}/proxy`} alt={asset.filename} />
        ) : (
          <div className="placeholder">Dérivé non disponible</div>
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
          ✕ Rejet
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
        <button className="btn" onClick={onNext} disabled={!hasNext}>
          →
        </button>
      </div>
    </div>
  );
}
