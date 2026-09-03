"use client";

// One chapter of the timeline: the editorial title, the context line, the
// folders it crosses, and a lazily fetched strip of sample tiles.
//
// The tiles are the gallery's: the ids come from lib/timeline.ts's spread
// sample, the rows from /api/assets?ids= (the shared GRID_SELECT), the markup
// mirrors VirtualGrid's tile so verdict borders, star and pair badges read the
// same here as everywhere else. Fetching happens on first sight only — thirty
// chapters cost thirty small requests spread over a scroll, not at load.
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { fetchJson } from "@/lib/fetchJson";
import { formatBadge } from "@/lib/format";
import type { TimelineChapter } from "@/lib/timeline";
import type { GalleryAsset } from "@/app/gallery/VirtualGrid";
import type { ViewerItem } from "@/app/MediaViewer";

export type Row = GalleryAsset & ViewerItem & { captured_at: string | null };

const DAYS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const MONTHS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
const HOUR_MS = 3_600_000;

/** A capture instant read in the chapter's own local day (cf.
 *  tzOffsetFromLongitude): shift by the offset, then take the UTC parts. */
function localDay(iso: string, offsetHours: number | null) {
  return new Date(Date.parse(iso) + (offsetHours ?? 0) * HOUR_MS);
}
const isoDate = (d: Date) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;

function spanLabel(ch: TimelineChapter) {
  const a = localDay(ch.started_at, ch.tz_offset_hours);
  const b = localDay(ch.ended_at, ch.tz_offset_hours);
  const da = `${a.getUTCDate()} ${MONTHS[a.getUTCMonth()]}`;
  const db = `${b.getUTCDate()} ${MONTHS[b.getUTCMonth()]}`;
  if (isoDate(a) === isoDate(b)) return da;
  if (a.getUTCMonth() === b.getUTCMonth()) return `${a.getUTCDate()} → ${db}`;
  return `${da} → ${db}`;
}

function durationLabel(ch: TimelineChapter) {
  const a = localDay(ch.started_at, ch.tz_offset_hours);
  const b = localDay(ch.ended_at, ch.tz_offset_hours);
  const days = Math.round((Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()) -
    Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate())) / 86_400_000) + 1;
  if (days > 1) return `${days} jours`;
  const h = Math.max(1, Math.round((Date.parse(ch.ended_at) - Date.parse(ch.started_at)) / HOUR_MS));
  return `${h} h`;
}

const tzLabel = (h: number | null) =>
  h == null ? "UTC" : `UTC${h >= 0 ? "+" : "−"}${Math.abs(h)}`;

export default function ChapterCard({
  chapter: ch,
  gridHref,
  onOpen,
  viewerRows,
}: {
  chapter: TimelineChapter;
  /** The grid this chapter's "see all" drills into (Incoming or Gallery). */
  gridHref: string;
  onOpen: (rows: Row[], index: number) => void;
  /** The viewer's live rows, when it is open on this chapter: a rating made
   *  there must show on the tile underneath without a refetch. */
  viewerRows?: Row[];
}) {
  const ref = useRef<HTMLElement>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [failed, setFailed] = useState(false);

  // Fetch on first sight, once. The strip is a fixed handful of ids, so the
  // request is tiny; what we avoid is thirty of them on page load.
  useEffect(() => {
    if (rows || !ch.sample_ids.length) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      load();
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          obs.disconnect();
          load();
        }
      },
      { rootMargin: "400px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
    function load() {
      fetchJson<{ assets: Row[] }>(
        `/api/assets?ids=${ch.sample_ids.join(",")}&collapse=1&sort_dir=asc&limit=${ch.sample_ids.length}`,
      )
        .then((d) => setRows(d.assets))
        .catch(() => setFailed(true));
    }
    // ch.sample_ids is stable for a given chapter key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ch.key]);

  // Let a rating made in the viewer flow back onto the tile.
  useEffect(() => {
    if (!viewerRows || !rows) return;
    const byId = new Map(viewerRows.map((r) => [r.id, r]));
    if (!rows.some((r) => byId.has(r.id))) return;
    setRows((cur) => cur && cur.map((r) => byId.get(r.id) ?? r));
  }, [viewerRows]); // eslint-disable-line react-hooks/exhaustive-deps

  const a = localDay(ch.started_at, ch.tz_offset_hours);
  const b = localDay(ch.ended_at, ch.tz_offset_hours);
  // The grid filters on capture_date, which is UTC: hand it the UTC dates, not
  // the local ones, or a sunrise chapter would drill into the wrong day.
  const seeAll = `${gridHref}?date_from=${ch.started_at.slice(0, 10)}&date_to=${ch.ended_at.slice(0, 10)}`;
  const shown = rows?.length ?? ch.sample_ids.length;

  return (
    <article className="tl-chapter" id={`tl-${ch.key}`} ref={ref}>
      <div className="tl-ch-head">
        <div>
          <h3 className="tl-ch-title">{ch.name}</h3>
          <span className="tl-ch-dates">
            {spanLabel(ch)} · {durationLabel(ch)}
          </span>
        </div>
        <div className="tl-ch-actions">
          <Link className="btn btn-sm" href={seeAll}>
            Ouvrir dans la grille
          </Link>
        </div>
      </div>
      <div className="tl-ch-meta">
        <span>
          <b className="num">{ch.count.toLocaleString()}</b> médias
        </span>
        {ch.devices.length > 0 && (
          <>
            <span className="tl-sep">·</span>
            <span>{ch.devices.join(" · ")}</span>
          </>
        )}
        {ch.places.length > 1 && (
          <>
            <span className="tl-sep">·</span>
            <span title="Lieux traversés, du plus photographié au moins">
              {ch.places.slice(1, 4).join(", ")}
              {ch.places.length > 4 ? "…" : ""}
            </span>
          </>
        )}
        <span className="tl-sep">·</span>
        <span
          title={
            ch.tz_offset_hours == null
              ? "Aucune position GPS : les jours sont lus en UTC"
              : "Décalage déduit de la longitude du chapitre — approximatif aux frontières de fuseau"
          }
        >
          jours locaux · {tzLabel(ch.tz_offset_hours)}
        </span>
        {ch.place_inferred && (
          <span
            className="tl-inferred"
            title="Aucun média de ce chapitre n'a de position : le lieu vient des chapitres voisins. Rien n'a été écrit."
          >
            lieu déduit
          </span>
        )}
        {ch.sessions.length > 0 && (
          <>
            <span className="tl-sep">·</span>
            {ch.sessions.slice(0, 4).map((s) => (
              <Link key={s.id} className="tl-session-tag" href={`/sessions/${s.id}`} title={s.name}>
                {s.name}
              </Link>
            ))}
            {ch.sessions.length > 4 && (
              <span className="tl-session-tag">+{ch.sessions.length - 4}</span>
            )}
          </>
        )}
      </div>

      {isoDate(a) !== isoDate(b) && (
        <div className="tl-day">
          <span className="tl-day-label">
            {DAYS[a.getUTCDay()]} {a.getUTCDate()} {MONTHS[a.getUTCMonth()]} → {DAYS[b.getUTCDay()]}{" "}
            {b.getUTCDate()} {MONTHS[b.getUTCMonth()]}
          </span>
          <i className="tl-day-rule" />
        </div>
      )}

      <div className="tl-row">
        {rows
          ? rows.map((r, i) => <Tile key={r.id} a={r} onClick={() => onOpen(rows, i)} />)
          : failed
            ? <span className="hint">Vignettes indisponibles.</span>
            : <div className="tl-row-skeleton">
                {ch.sample_ids.map((id) => <span key={id} className="skeleton" />)}
              </div>}
        {ch.count > shown && (
          <Link className="tl-more" href={seeAll}>
            <span className="n">+{(ch.count - shown).toLocaleString()}</span>
            voir tout
          </Link>
        )}
      </div>
    </article>
  );
}

// VirtualGrid's tile, minus the touch/long-press plumbing the grid needs and
// this strip does not. Same classes, same badges, same order of corners.
function Tile({ a, onClick }: { a: Row; onClick: () => void }) {
  return (
    <div className={`cell ${a.verdict}`} onClick={onClick} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } }}>
      {a.derivative_status === "ready" ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`/api/assets/${a.id}/thumb`} alt={a.filename} loading="lazy" decoding="async" />
      ) : (
        <div className="placeholder">
          {a.derivative_status === "error" ? "⚠ error" : a.media_type === "video" ? "🎬 video" : "⏳"}
        </div>
      )}
      {a.media_type === "video" && a.derivative_status === "ready" && (
        <span className="play-badge">▶</span>
      )}
      {(a.burst_count ?? 0) > 1 && (
        <span className={`stack-badge${a.burst_kind === "bracket" ? " bracket" : ""}`}>
          {a.burst_kind === "bracket" ? "±" : "⧉"} {a.burst_count}
        </span>
      )}
      {a.verdict !== "unrated" && (
        <span className="badge">{a.verdict === "pick" ? "✓" : a.verdict === "reject" ? "✕" : "↪"}</span>
      )}
      {a.star > 0 && <span className="stars">{"★".repeat(a.star)}</span>}
      <span className={`ext-badge${a.companion_ext ? " paired" : ""}`}>
        {formatBadge(a.ext, a.companion_ext, a.group_kind)}
      </span>
    </div>
  );
}
