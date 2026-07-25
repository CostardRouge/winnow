"use client";

// The /gear shelf: every camera body and every lens the library was shot with,
// each drawn as line-art (cf. CameraArt / LensArt) with the number of frames it
// took. A gear card is a shortcut, not a museum label — tapping one opens the
// Incoming grid filtered on that body/lens, so "what did I shoot on the X-T5"
// is one click away.
//
// The counts are library-wide (that's the honest "frames taken with this
// camera"), while the drill-in targets Incoming/Grid — the one gallery view that
// seeds its filters from the URL (cf. IncomingTab), and where the originals live.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { fetchJson } from "@/lib/fetchJson";
import { friendlyCameraName } from "@/lib/cameraLabels";
import { lensArt, lensSpec } from "@/lib/gearArt";
import type { GearCamera, GearLens, GearResponse } from "@/lib/gearTypes";
import { EmptyState, Icons, LoadingState } from "@/app/ui";
import CameraArt from "./CameraArt";
import LensArt from "./LensArt";

type Sort = "used" | "recent";

const SORTS: { key: Sort; label: string; title: string }[] = [
  { key: "used", label: "Most used", title: "Busiest gear first" },
  { key: "recent", label: "Recent", title: "Most recently used first" },
];

const num = (n: number) => n.toLocaleString();

/** "2019–2026" — the years a piece of gear was in service, from its frames. */
function years(first: string | null, last: string | null): string | null {
  const year = (iso: string | null) => {
    if (!iso) return null;
    const y = new Date(iso).getFullYear();
    return Number.isFinite(y) ? y : null;
  };
  const a = year(first);
  const b = year(last) ?? a;
  if (a == null) return null;
  return a === b ? `${a}` : `${a}–${b}`;
}

/** Photos, videos, or a mixed bag — the pill under the artwork. */
function countLabel(photos: number, videos: number, total: number): string {
  if (videos === 0) return `${num(photos)} ${photos === 1 ? "photo" : "photos"}`;
  if (photos === 0) return `${num(videos)} ${videos === 1 ? "video" : "videos"}`;
  return `${num(total)} media`;
}

/** Mixed libraries get the split spelled out; single-medium ones don't need it. */
function splitLine(photos: number, videos: number): string | null {
  if (photos > 0 && videos > 0) return `${num(photos)} photos · ${num(videos)} videos`;
  return null;
}

function byRecent(a: { last_capture: string | null }, b: { last_capture: string | null }) {
  return (b.last_capture ?? "").localeCompare(a.last_capture ?? "");
}

function Card({
  href,
  art,
  kind,
  name,
  label,
  count,
  meta,
}: {
  href: string;
  art: ReactNode;
  /** Bodies are drawn wide, lenses tall — each artwork gets its own width cap. */
  kind: "camera" | "lens";
  /** Raw EXIF string — surfaced as the tooltip when the label was prettified. */
  name: string;
  label: string;
  count: string;
  meta: (string | null)[];
}) {
  const lines = meta.filter(Boolean) as string[];
  return (
    <Link href={href} className="gear-card" title={name === label ? undefined : name}>
      <span className={`gear-art gear-art-${kind}`}>{art}</span>
      <span className="gear-name">{label}</span>
      <span className="pill gear-count">{count}</span>
      {lines.length > 0 && (
        <span className="gear-meta">
          {lines.map((l) => (
            <span key={l} className="gear-meta-line">
              {l}
            </span>
          ))}
        </span>
      )}
    </Link>
  );
}

export default function GearPanel() {
  const [data, setData] = useState<GearResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>("used");

  useEffect(() => {
    fetchJson<GearResponse>("/api/gear")
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load"));
  }, []);

  // The API already returns both lists busiest-first; "Recent" re-sorts on the
  // client — a shelf is small enough that a round-trip per sort would be silly.
  const cameras = useMemo<GearCamera[]>(() => {
    const list = data?.cameras ?? [];
    return sort === "recent" ? [...list].sort(byRecent) : list;
  }, [data, sort]);
  const lenses = useMemo<GearLens[]>(() => {
    const list = data?.lenses ?? [];
    return sort === "recent" ? [...list].sort(byRecent) : list;
  }, [data, sort]);

  if (error) {
    return (
      <div className="empty-state error" role="alert">
        {error}
      </div>
    );
  }
  if (!data) return <LoadingState label="Reading the EXIF…" />;

  if (cameras.length === 0 && lenses.length === 0) {
    return (
      <EmptyState
        icon={Icons.photos}
        title="No gear yet"
        hint="Cameras and lenses appear here as soon as indexed media carry EXIF maker/model tags."
      />
    );
  }

  const totalFrames = cameras.reduce((s, c) => s + c.count, 0);

  return (
    <div className="gear-shelf">
      <div className="gear-head">
        <span className="hint">
          {cameras.length} {cameras.length === 1 ? "body" : "bodies"} · {lenses.length}{" "}
          {lenses.length === 1 ? "lens" : "lenses"} · {num(totalFrames)} media
        </span>
        <span className="spacer" />
        <div className="view-toggle" role="group" aria-label="Sort gear">
          {SORTS.map((s) => (
            <button
              key={s.key}
              className={`view-btn${sort === s.key ? " active" : ""}`}
              onClick={() => setSort(s.key)}
              aria-pressed={sort === s.key}
              title={s.title}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {cameras.length > 0 && (
        <section className="gear-section">
          <h2>Cameras</h2>
          <div className="gear-grid">
            {cameras.map((c) => (
              <Card
                key={c.name}
                href={`/library/incoming/grid?device=${encodeURIComponent(c.name)}`}
                art={<CameraArt name={c.name} />}
                kind="camera"
                name={c.name}
                label={c.label}
                count={countLabel(c.photos, c.videos, c.count)}
                meta={[
                  years(c.first_capture, c.last_capture),
                  splitLine(c.photos, c.videos),
                  c.top_lens ? `mostly ${c.top_lens}` : null,
                ]}
              />
            ))}
          </div>
        </section>
      )}

      {lenses.length > 0 && (
        <section className="gear-section">
          <h2>Lenses</h2>
          <div className="gear-grid">
            {lenses.map((l) => (
              <Card
                key={l.name}
                href={`/library/incoming/grid?lens=${encodeURIComponent(l.name)}`}
                art={
                  <LensArt
                    name={l.name}
                    focalMin={l.focal_min}
                    focalMax={l.focal_max}
                    aperture={l.aperture_min}
                  />
                }
                kind="lens"
                name={l.name}
                label={l.name}
                count={countLabel(l.photos, l.videos, l.count)}
                meta={[
                  // The spec line is derived, so a lens whose name states nothing
                  // ("E 18-55") still shows the range its frames recorded.
                  lensSpec(
                    lensArt(l.name, {
                      focalMin: l.focal_min,
                      focalMax: l.focal_max,
                      aperture: l.aperture_min,
                    }),
                  ) || null,
                  years(l.first_capture, l.last_capture),
                  l.top_body ? `on ${friendlyCameraName(l.top_body)}` : null,
                ]}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
