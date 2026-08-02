"use client";

import { useEffect, useState } from "react";
import { fetchJson } from "@/lib/fetchJson";
import MediaViewer from "../MediaViewer";
import type { AssetGridRow } from "@/lib/types";

// "Similar photos" strip for the viewer's info panel: the visually closest
// media by perceptual-hash distance (GET /api/assets/:id/similar, cf.
// lib/ml.ts). Surfaces near-duplicates — the same frame re-exported, burst
// neighbours, a slightly different crop — right where the keep/reject decision
// is made. Renders nothing until the asset (and at least one other) has been
// analyzed, so the panel stays clean on a library without the ML feature.
//
// Clicking a thumb opens the similar shot in a SECOND viewer stacked on top of
// the current one (closing it lands back on the first) — the strip's whole
// point is comparing, and the shot may live outside the host's loaded list
// (another session, filtered out), so an overlay is the one navigation that
// always works. MediaViewer's own stack keeps the keyboard on the top layer.
export type SimilarItem = {
  id: number;
  filename: string;
  ext: string;
  media_type: "photo" | "video";
  captured_at: string | null;
  distance: number;
};

// The strip asks for a tighter cut than the API's default (16): over a large
// library the 12-16 band is mostly chance collisions between unrelated hashes
// (P(d<=16) ~ 4e-5 per pair — a few per query over 80k assets), and flat/
// blurry frames cluster even closer. <=10 is the "very close" zone the strip
// is for.
const MAX_DISTANCE = 10;

export default function SimilarStrip({ assetId }: { assetId: number }) {
  const [items, setItems] = useState<SimilarItem[] | null>(null);
  // Index (into items) of the shot opened in the stacked viewer, if any.
  const [open, setOpen] = useState<number | null>(null);
  // Full grid rows fetched for opened shots, keyed by asset id: the strip's
  // own payload is deliberately thin, so the stacked viewer pulls the rest
  // (EXIF, dimensions, pairing…) on demand and the panel fills in as it lands.
  const [details, setDetails] = useState<Record<number, AssetGridRow>>({});

  useEffect(() => {
    let alive = true;
    setItems(null);
    setOpen(null);
    fetchJson<{ items: SimilarItem[] }>(
      `/api/assets/${assetId}/similar?limit=8&max_distance=${MAX_DISTANCE}`,
    )
      .then((d) => alive && setItems(d.items))
      .catch(() => alive && setItems([]));
    return () => {
      alive = false;
    };
  }, [assetId]);

  // Fetch the displayed shot's full row once per asset (the `details` guard
  // makes the post-fetch re-run a no-op). Failure is fine: the viewer already
  // shows the media from the thin item, just with a sparser panel.
  useEffect(() => {
    if (open == null || !items) return;
    const it = items[open];
    if (!it || details[it.id]) return;
    let alive = true;
    fetchJson<{ asset: AssetGridRow }>(`/api/assets/${it.id}`)
      .then((d) => alive && setDetails((m) => ({ ...m, [it.id]: d.asset })))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open, items, details]);

  if (!items?.length) return null;

  return (
    <div className="viewer-similar">
      <div className="viewer-similar-label">Similar</div>
      <div style={{ display: "flex", gap: 6, overflowX: "auto" }}>
        {items.map((s, i) => (
          <button
            key={s.id}
            onClick={() => setOpen(i)}
            title={`${s.filename} · distance ${s.distance} — click to view`}
            style={{
              padding: 0,
              border: "none",
              background: "none",
              cursor: "pointer",
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
              className="viewer-similar-dist"
              aria-label={`distance ${s.distance}`}
            >
              {s.distance}
            </span>
          </button>
        ))}
      </div>
      {open != null && items[open] && (
        <MediaViewer
          items={items.map((s) => ({ ...s, ...(details[s.id] ?? {}) }))}
          index={open}
          onIndexChange={setOpen}
          onClose={() => setOpen(null)}
          renderInfo={(it) => (
            <div className="viewer-tags">
              <span
                className="chip"
                title="Perceptual-hash (Hamming) distance to the photo underneath — 0 is identical"
              >
                distance {it.distance}
              </span>
            </div>
          )}
        />
      )}
    </div>
  );
}
