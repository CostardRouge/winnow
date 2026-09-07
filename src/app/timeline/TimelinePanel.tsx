"use client";

// /timeline — the chapter stream, its controls, the spine, and one viewer.
//
// Everything on screen is derived per request by GET /api/assets/timeline
// (cf. lib/timeline.ts): the page owns only the reading options (cut rule,
// place granularity, which half of the library) and mirrors them into the URL
// so a timeline is shareable, like the gallery's filters. Tiles are fetched
// per chapter, lazily, through the gallery's own /api/assets?ids= projection —
// so a tile, its badges, its rating and the viewer are the gallery's, not a
// second implementation that would drift.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { fetchJson } from "@/lib/fetchJson";
import type {
  ChapterMode,
  PlaceGranularity,
  TimelineChapter,
} from "@/lib/timeline";
import { EmptyState, Icons, LoadingOverlay, LoadingState } from "@/app/ui";
import {
  LibrarySourceTabs,
  LIBRARY_SOURCES,
  useStoredLibrarySource,
  type LibrarySource,
} from "@/app/LibrarySourceTabs";
import MediaViewer, { type ViewerItem } from "@/app/MediaViewer";
import ViewerActions from "@/app/ViewerActions";
import type { GalleryAsset } from "@/app/gallery/VirtualGrid";
import GeotagRecapModal, { type GeotagRecapAsset } from "@/app/GeotagRecapModal";
import type { PickedLocation } from "@/app/LocationPickerModal";
import ChapterCard, { type Row } from "./ChapterCard";
import ChapterEditModal from "./ChapterEditModal";

// Leaflet touches `window` at import time: client-only, like the gallery.
const LocationPickerModal = dynamic(() => import("@/app/LocationPickerModal"), {
  ssr: false,
});

// A chapter's media that carry no position, paged through the shared
// /api/assets feed (has_gps=0) so the recap lists exactly what the grid would.
// Capped at PAGE_MAX per page, cursor-driven; a chapter is at most a few
// thousand frames, so this is a handful of requests at worst.
async function fetchUngeotagged(
  ch: TimelineChapter,
  kind: string | null,
): Promise<GeotagRecapAsset[]> {
  const out: GeotagRecapAsset[] = [];
  let cursor: string | null = null;
  do {
    const sp = new URLSearchParams();
    sp.set("date_from", ch.started_at.slice(0, 10));
    sp.set("date_to", ch.ended_at.slice(0, 10));
    sp.set("has_gps", "0");
    sp.set("collapse", "1");
    sp.set("limit", "500");
    if (kind) sp.set("kind", kind);
    if (cursor) sp.set("cursor", cursor);
    const page: { assets: (GeotagRecapAsset & { captured_at: string | null })[]; next_cursor: string | null } =
      await fetchJson(`/api/assets?${sp.toString()}`);
    // capture_date is a UTC day; the chapter's bounds are instants. Keep only
    // what actually falls inside the chapter, not the whole edge days.
    for (const a of page.assets) {
      if (a.captured_at && a.captured_at >= ch.started_at && a.captured_at <= ch.ended_at) out.push(a);
    }
    cursor = page.next_cursor;
  } while (cursor);
  return out;
}

type Payload = {
  chapters: TimelineChapter[];
  granularity: PlaceGranularity;
  granularity_auto: boolean;
  spine: { year: number; month: number; count: number }[];
  undated: number;
};

const SOURCE_KEY = "winnow.timeline.source";

const MODES: { key: ChapterMode; label: string; title: string }[] = [
  { key: "place", label: "Place", title: "One chapter per place, however long the stay" },
  { key: "time", label: "Time", title: "One chapter per continuous stretch of shooting" },
  { key: "hybrid", label: "Hybrid", title: "A change of place or a long gap, with the crumbs absorbed" },
];

const GRAN_LABEL: Record<PlaceGranularity, string> = {
  city: "City",
  county: "County",
  region: "Region",
};
const GRAN_CYCLE: (PlaceGranularity | "auto")[] = ["auto", "region", "county", "city"];

const MONTHS_SHORT = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const isMode = (s: string | null): s is ChapterMode =>
  s === "place" || s === "time" || s === "hybrid";
const isGran = (s: string | null): s is PlaceGranularity | "auto" =>
  s === "auto" || s === "city" || s === "county" || s === "region";
const isSource = (s: string | null): s is LibrarySource =>
  s === "all" || s === "incoming" || s === "gallery";

// Which half of the library → the shared filter's `kind` (cf. lib/roles.ts).
// "All" is simply no scope: the filter runs over both.
const kindFor = (s: LibrarySource) =>
  s === "incoming" ? "incoming" : s === "gallery" ? "final" : null;

type ReadingOptions = {
  mode: ChapterMode;
  gran: PlaceGranularity | "auto";
  source: LibrarySource;
};

// What the loader says while a derivation is in flight. Every option change
// rebuilds the whole stream from a full scan (cf. lib/timeline.ts), which takes
// seconds on a real library — so the feedback names the change being applied,
// not just "loading": that is what tells the reader the click was heard and
// which of the three controls is answering. `prev === null` is the first read;
// same options means a refresh (a chapter edit, "Retry").
function readingLabel(prev: ReadingOptions | null, next: ReadingOptions): string {
  if (!prev) return "Reading the library…";
  if (prev.source !== next.source) {
    if (next.source === "all") return "Reading the whole library…";
    const label = LIBRARY_SOURCES.find((s) => s.key === next.source)?.label ?? next.source;
    return `Reading ${label}…`;
  }
  if (prev.mode !== next.mode) {
    const label = MODES.find((m) => m.key === next.mode)?.label ?? next.mode;
    return `New chapter rule: ${label}…`;
  }
  if (prev.gran !== next.gran)
    return next.gran === "auto"
      ? "Automatic grouping…"
      : `Grouping by ${GRAN_LABEL[next.gran].toLowerCase()}…`;
  return "Refreshing the chapters…";
}

export default function TimelinePanel() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // A shared link decides the first render; otherwise the choices stick
  // between visits the way /gear and /search remember theirs.
  const [mode, setMode] = useState<ChapterMode>(() => {
    const m = searchParams.get("mode");
    return isMode(m) ? m : "hybrid";
  });
  const [gran, setGran] = useState<PlaceGranularity | "auto">(() => {
    const g = searchParams.get("gran");
    return isGran(g) ? g : "auto";
  });
  const [urlSource] = useState<LibrarySource | null>(() => {
    const s = searchParams.get("source");
    return isSource(s) ? s : null;
  });
  const [source, setSource] = useStoredLibrarySource(SOURCE_KEY, urlSource);

  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  // What the loader announces, decided from what changed since the last read.
  const [loadingLabel, setLoadingLabel] = useState("Reading the library…");
  const lastRead = useRef<ReadingOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped by "Réessayer": same query, fresh request.
  const [attempt, setAttempt] = useState(0);

  // The viewer navigates within one chapter's loaded tiles: crossing into the
  // next chapter is a scroll away, and a flattened list would hand the viewer
  // items whose tiles never loaded.
  const [viewer, setViewer] = useState<{ rows: Row[]; index: number } | null>(null);
  // The chapter being renamed / split / merged, by key (the object is looked
  // up in the current payload so a re-derive never leaves a stale copy open).
  const [editing, setEditing] = useState<string | null>(null);
  // Only show the chapters whose place was inferred (no GPS at all): the
  // review list for "which of these do I want to confirm".
  const [onlyInferred, setOnlyInferred] = useState(false);

  // The ONE path from an inferred or chosen place to a coordinate on a media:
  // the existing manual geotag flow — picker (unless a location is already
  // chosen) → recap listing every media with its before/after → POST
  // /api/assets/geotag, which is what writes the EXIF. Nothing else in this
  // page writes a position (cf. docs/memory/architecture.md).
  const [geotag, setGeotag] = useState<{
    chapter: TimelineChapter;
    assets: GeotagRecapAsset[] | null;
    loc?: PickedLocation;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const startGeotag = useCallback(
    async (chapter: TimelineChapter, loc?: PickedLocation) => {
      setGeotag({ chapter, assets: null, loc });
      try {
        const assets = await fetchUngeotagged(chapter, kindFor(source));
        if (!assets.length) {
          setGeotag(null);
          setNotice("Every media in this chapter already has a position.");
          return;
        }
        setGeotag((g) => (g && g.chapter.key === chapter.key ? { ...g, assets } : g));
      } catch (e) {
        setGeotag(null);
        setNotice(`Couldn’t list the media with no position: ${(e as Error).message}`);
      }
    },
    [source],
  );

  const query = useMemo(() => {
    const sp = new URLSearchParams();
    sp.set("mode", mode);
    sp.set("gran", gran);
    const kind = kindFor(source);
    if (kind) sp.set("kind", kind);
    return sp.toString();
  }, [mode, gran, source]);

  // Mirror the reading options into the address bar (replace, not push — Back
  // leaves the page, it does not replay every toggle).
  useEffect(() => {
    try {
      const sp = new URLSearchParams(window.location.search);
      sp.set("mode", mode);
      sp.set("gran", gran);
      sp.set("source", source);
      router.replace(`/timeline?${sp.toString()}`, { scroll: false });
    } catch {
      /* non-fatal */
    }
  }, [mode, gran, source, router]);

  useEffect(() => {
    let cancelled = false;
    const next: ReadingOptions = { mode, gran, source };
    setLoadingLabel(readingLabel(lastRead.current, next));
    lastRead.current = next;
    setLoading(true);
    setError(null);
    fetchJson<Payload>(`/api/assets/timeline?${query}`)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // mode/gran/source only feed the label; `query` is what actually changes.
  }, [query, attempt, mode, gran, source]);

  // Optimistic rating, the gallery's own shape (GalleryShell.rate): patch the
  // open viewer's row, then the server. Chapter tiles re-read their rows from
  // the same object, so the border follows.
  const rate = useCallback(
    async (id: number, patch: { verdict?: GalleryAsset["verdict"]; star?: number }) => {
      setViewer((v) =>
        v ? { ...v, rows: v.rows.map((r) => (r.id === id ? { ...r, ...patch } : r)) } : v,
      );
      await fetch(`/api/assets/${id}/rating`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    },
    [],
  );

  const total = useMemo(
    () => data?.chapters.reduce((n, c) => n + c.count, 0) ?? 0,
    [data],
  );

  // Chapters grouped under their year, for the sticky era bracket.
  const eras = useMemo(() => {
    const out: { year: number; chapters: TimelineChapter[] }[] = [];
    const list = (data?.chapters ?? []).filter((c) => !onlyInferred || c.place_inferred);
    for (const ch of list) {
      const y = new Date(ch.started_at).getUTCFullYear();
      const last = out[out.length - 1];
      if (last && last.year === y) last.chapters.push(ch);
      else out.push({ year: y, chapters: [ch] });
    }
    return out;
  }, [data, onlyInferred]);

  const streamRef = useRef<HTMLDivElement>(null);
  const jumpTo = (year: number, month: number) => {
    const target = data?.chapters.find((c) => {
      const d = new Date(c.started_at);
      return d.getUTCFullYear() === year && d.getUTCMonth() + 1 === month;
    });
    const el = target && document.getElementById(`tl-${target.key}`);
    el?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  const gridHref = (s: LibrarySource) =>
    s === "gallery" ? "/library/gallery" : "/library/incoming/grid";

  const granChip = data ? (
    <button
      className={`chip${gran !== "auto" ? " active" : ""}`}
      title={
        gran === "auto"
          ? "Grouping chosen for the period on screen — click to pin it"
          : "Grouping pinned — click to change level"
      }
      onClick={() => setGran(GRAN_CYCLE[(GRAN_CYCLE.indexOf(gran) + 1) % GRAN_CYCLE.length])}
    >
      Grouping · {GRAN_LABEL[data.granularity]}
      <span className="chip-count">{gran === "auto" ? "auto" : "pinned"}</span>
    </button>
  ) : null;

  return (
    <div className="app-shell">
      <div className="topbar">
        <h1>Timeline</h1>
        <span className="hint max-sm:hidden">the library read as a story</span>
        <span className="spacer" />
        {data && (
          <span className="hint" style={{ fontFamily: "var(--font-mono)" }}>
            {total.toLocaleString()} media · {data.chapters.length} chapters
          </span>
        )}
      </div>

      <div className="gallery-controls">
        <div className="tabs" role="group" aria-label="Chapter rule">
          {MODES.map((m) => (
            <button
              key={m.key}
              className={`tab${mode === m.key ? " active" : ""}`}
              onClick={() => setMode(m.key)}
              aria-pressed={mode === m.key}
              title={m.title}
            >
              {m.label}
            </button>
          ))}
        </div>
        {mode !== "time" && granChip}
        {/* No shared filter isolates undated media yet, so this is a count, not
            a link: the difference between a view that is incomplete and one
            that is silently wrong. */}
        {data && data.undated > 0 && (
          <span
            className="chip"
            title="Media with no capture date: they cannot be placed on the timeline and stay visible in the grid"
          >
            {Icons.alert} {data.undated.toLocaleString()} undated
          </span>
        )}
        {data && data.chapters.some((c) => c.place_inferred) && (
          <button
            className={`chip${onlyInferred ? " active" : ""}`}
            onClick={() => setOnlyInferred((v) => !v)}
            aria-pressed={onlyInferred}
            title="Only show the chapters whose place was inferred from their neighbours (no geotagged media at all)"
          >
            inferred places
            <span className="chip-count">{data.chapters.filter((c) => c.place_inferred).length}</span>
          </button>
        )}
        <span className="spacer" />
        <LibrarySourceTabs source={source} onChange={setSource} />
      </div>
      {notice && (
        <div className="gallery-controls" role="status">
          <span className="hint">{notice}</span>
          <span className="spacer" />
          <button className="btn btn-sm" onClick={() => setNotice(null)}>
            OK
          </button>
        </div>
      )}

      <div className="tl-body" aria-busy={loading}>
        <div className="tl-stream" ref={streamRef}>
          {error && (
            <div className="error-box">
              <span>{error}</span>
              <button className="btn btn-sm" onClick={() => setAttempt((n) => n + 1)}>
                Retry
              </button>
            </div>
          )}
          {data && data.chapters.length === 0 && !loading && (
            <EmptyState
              title="Nothing to tell here"
              hint={
                source === "gallery"
                  ? "The Gallery holds no dated media."
                  : "No dated media in this half of the library."
              }
            />
          )}
          {eras.map((era) => (
            <section key={era.year}>
              <div className="tl-era">
                <span className="tl-era-name">{era.year}</span>
                <span className="tl-era-meta">
                  {era.chapters.length} chapter{era.chapters.length > 1 ? "s" : ""} ·{" "}
                  {era.chapters.reduce((n, c) => n + c.count, 0).toLocaleString()} media
                </span>
              </div>
              {era.chapters.map((ch) => (
                <ChapterCard
                  key={ch.key}
                  chapter={ch}
                  gridHref={gridHref(source)}
                  onOpen={(rows, index) => setViewer({ rows, index })}
                  onEdit={(c) => setEditing(c.key)}
                  onConfirmPlace={(c) => startGeotag(c)}
                  onPlaceMedia={(c, loc) => startGeotag(c, loc)}
                  viewerRows={viewer?.rows}
                />
              ))}
            </section>
          ))}
        </div>

        {data && data.spine.length > 0 && (
          <Spine
            spine={data.spine}
            activeKey={data.chapters[0] ? monthKey(data.chapters[0].started_at) : null}
            onJump={jumpTo}
          />
        )}

        {/* The one loader of this page: the first read draws it over an empty
            zone, every later one over the previous answer, which stays visible
            but blurred and unclickable until the new derivation lands. */}
        {loading && <LoadingOverlay label={loadingLabel} />}
      </div>

      {editing != null && data && (() => {
        const idx = data.chapters.findIndex((c) => c.key === editing);
        if (idx < 0) return null;
        return (
          <ChapterEditModal
            chapter={data.chapters[idx]}
            prev={data.chapters[idx - 1] ?? null}
            next={data.chapters[idx + 1] ?? null}
            onClose={() => setEditing(null)}
            onChanged={() => setAttempt((n) => n + 1)}
            onPlaceMedia={(loc) => startGeotag(data.chapters[idx], loc)}
          />
        );
      })()}

      {geotag && !geotag.loc && (
        <LocationPickerModal
          count={geotag.chapter.ungeotagged}
          initial={
            geotag.chapter.place_lat != null && geotag.chapter.place_lon != null
              ? { lat: geotag.chapter.place_lat, lon: geotag.chapter.place_lon }
              : null
          }
          onClose={() => setGeotag(null)}
          onPicked={(loc) => setGeotag((g) => (g ? { ...g, loc } : g))}
        />
      )}
      {geotag?.loc && geotag.assets && (
        <GeotagRecapModal
          assets={geotag.assets}
          target={geotag.loc}
          onClose={() => setGeotag(null)}
          onApplied={(message) => {
            setGeotag(null);
            setNotice(message);
            // The media now carry a position: the chapter stops being
            // inferred on the next derivation.
            setAttempt((n) => n + 1);
          }}
        />
      )}
      {geotag?.loc && !geotag.assets && (
        <div className="modal-overlay" role="presentation">
          <div className="modal">
            <LoadingState label="Listing the media with no position…" />
          </div>
        </div>
      )}

      {viewer && viewer.rows[viewer.index] && (
        <MediaViewer
          items={viewer.rows}
          index={viewer.index}
          onIndexChange={(i) => setViewer((v) => (v ? { ...v, index: i } : v))}
          onClose={() => setViewer(null)}
          onKeyDown={(e, it) => {
            // P/X/U/0-5 — the gallery's shortcuts, so the hands do not relearn.
            const k = e.key.toLowerCase();
            if (k === "p") return void rate(it.id, { verdict: it.verdict === "pick" ? "unrated" : "pick" });
            if (k === "x") return void rate(it.id, { verdict: it.verdict === "reject" ? "unrated" : "reject" });
            if (k === "u") return void rate(it.id, { verdict: "unrated" });
            if (/^[0-5]$/.test(e.key)) return void rate(it.id, { star: Number(e.key) });
          }}
          renderActions={(it) => (
            <ViewerActions
              verdict={it.verdict}
              star={it.star}
              onVerdict={(verdict) => rate(it.id, { verdict })}
              onStar={(star) => rate(it.id, { star })}
              onExport={() => router.push(`${gridHref(source)}?ids=${it.id}`)}
              onRegenerate={() => fetch("/api/assets/regenerate", jsonPost({ ids: [it.id] }))}
              onGeocode={() => fetch("/api/assets/geocode", jsonPost({ ids: [it.id] }))}
              onDelete={() => fetch("/api/assets/delete", jsonPost({ ids: [it.id] })).then(() => setViewer(null))}
            />
          )}
        />
      )}
    </div>
  );
}

const jsonPost = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const monthKey = (iso: string) => {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`;
};

function Spine({
  spine,
  activeKey,
  onJump,
}: {
  spine: { year: number; month: number; count: number }[];
  activeKey: string | null;
  onJump: (year: number, month: number) => void;
}) {
  const max = Math.max(1, ...spine.map((m) => m.count));
  // Fill the gaps so an empty month still shows as a hairline: silence is
  // information on a timeline.
  const rows: { year: number; month: number; count: number }[] = [];
  const first = spine[0];
  const last = spine[spine.length - 1];
  for (let y = first.year; y <= last.year; y++) {
    const mFrom = y === first.year ? first.month : 1;
    const mTo = y === last.year ? last.month : 12;
    for (let m = mFrom; m <= mTo; m++) {
      rows.push(spine.find((s) => s.year === y && s.month === m) ?? { year: y, month: m, count: 0 });
    }
  }
  let year: number | null = null;
  return (
    <div className="tl-spine" aria-label="Months">
      {rows.map((r) => {
        const head = r.year !== year ? <div className="tl-spine-year">{r.year}</div> : null;
        year = r.year;
        const active = activeKey === `${r.year}-${r.month}`;
        return (
          <div key={`${r.year}-${r.month}`}>
            {head}
            <button
              className={`tl-spine-row${active ? " active" : ""}`}
              title={`${r.count.toLocaleString()} media`}
              onClick={() => r.count && onJump(r.year, r.month)}
              disabled={!r.count}
            >
              <span className="tl-spine-m">{MONTHS_SHORT[r.month - 1]}</span>
              <i
                className="tl-spine-bar"
                style={{ width: r.count ? 6 + (r.count / max) * 40 : 2, opacity: r.count ? 1 : 0.35 }}
              />
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ViewerItem is what MediaViewer needs; the /api/assets rows carry it.
export type { ViewerItem };
