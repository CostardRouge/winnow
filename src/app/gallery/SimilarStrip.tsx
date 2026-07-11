"use client";

import { useEffect, useState } from "react";
import { fetchJson } from "@/lib/fetchJson";

// "Similar photos" strip for the viewer's info panel: the visually closest
// media by perceptual-hash distance (GET /api/assets/:id/similar, cf.
// lib/ml.ts). Surfaces near-duplicates — the same frame re-exported, burst
// neighbours, a slightly different crop — right where the keep/reject decision
// is made. Renders nothing until the asset (and at least one other) has been
// analyzed, so the panel stays clean on a library without the ML feature.
export type SimilarItem = {
  id: number;
  filename: string;
  ext: string;
  media_type: "photo" | "video";
  captured_at: string | null;
  distance: number;
};

export default function SimilarStrip({
  assetId,
  onOpen,
}: {
  assetId: number;
  /** Jump the viewer to this asset when it's reachable in the current list. */
  onOpen?: (id: number) => void;
}) {
  const [items, setItems] = useState<SimilarItem[] | null>(null);

  useEffect(() => {
    let alive = true;
    setItems(null);
    fetchJson<{ items: SimilarItem[] }>(`/api/assets/${assetId}/similar?limit=8`)
      .then((d) => alive && setItems(d.items))
      .catch(() => alive && setItems([]));
    return () => {
      alive = false;
    };
  }, [assetId]);

  if (!items?.length) return null;

  return (
    <div className="viewer-similar">
      <div className="hint" style={{ margin: "8px 0 4px" }}>
        Similar
      </div>
      <div style={{ display: "flex", gap: 6, overflowX: "auto" }}>
        {items.map((s) => (
          <button
            key={s.id}
            onClick={() => onOpen?.(s.id)}
            title={`${s.filename} · distance ${s.distance}`}
            style={{
              padding: 0,
              border: "none",
              background: "none",
              cursor: onOpen ? "pointer" : "default",
              position: "relative",
              flex: "0 0 auto",
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/assets/${s.id}/thumb`}
              alt={s.filename}
              loading="lazy"
              style={{
                height: 56,
                width: "auto",
                borderRadius: 4,
                display: "block",
              }}
            />
            <span
              className="chip-count"
              style={{ position: "absolute", right: 2, bottom: 2 }}
              aria-label={`distance ${s.distance}`}
            >
              {s.distance}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
