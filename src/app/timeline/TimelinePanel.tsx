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
import { useRouter, useSearchParams } from "next/navigation";
import { fetchJson } from "@/lib/fetchJson";
import { geotagTargets, type GeotagAsset, type GeotagSource } from "@/lib/assetActions";
import { distanceM, UNPLACED_RULES } from "@/lib/unplacedTypes";
import type {
  ChapterMode,
  PlaceGranularity,
  TimelineChapter,
} from "@/lib/timeline";
import { EmptyState, Icons, LoadingOverlay, LoadingState } from "@/app/ui";
import PageHeader from "@/app/PageHeader";
import { OptionPicker, type PickerOption } from "@/app/OptionPicker";
import {
  LibrarySourceTabs,
  LIBRARY_SOURCES,
  useStoredLibrarySource,
  type LibrarySource,
} from "@/app/LibrarySourceTabs";
import MediaViewer, { type ViewerItem } from "@/app/MediaViewer";
import ViewerActions from "@/app/ViewerActions";
import type { GalleryAsset } from "@/app/gallery/VirtualGrid";
import GeotagRecapModal, { type RecapFolder, type RecapPlace } from "@/app/GeotagRecapModal";
import type { PickedLocation } from "@/app/LocationPicker";
import { fetchNearPlaces } from "@/app/nearPlaces";
import ChapterCard, { type Row } from "./ChapterCard";
import ChapterEditModal from "./ChapterEditModal";

// Placing a chapter's media is the Unplaced view's Place, not a flow of its
// own (docs/UNPLACED.md, docs/memory/frontend.md): ONE dialog — the recap with
// the map in it (GeotagRecapModal + `onTargetChange`) — listing the chapter's
// media folder by folder, the positions already placed around its dates as
// chips, and the same record rule: a pin taken as offered from a spot that was
// itself an accepted suggestion stays 'inferred' (never written into a file),
// anything a human put down is 'manual'. It replaced a two-step picker →
// fixed recap that knew none of that.
type PlaceFlow = {
  chapter: TimelineChapter;
  /** Every live, non-exempt media of the chapter's folders inside its span,
   *  both members of a pair — null while they are listed. */
  assets: GeotagAsset[] | null;
  folders: RecapFolder[];
  places: RecapPlace[];
  /** The chips that are accepted suggestions: taken as offered, they record
   *  'inferred' — borrowing a guess must not make it a fact. */
  unverified: { lat: number; lon: number }[];
  /** Screenshots, saved files, graded exports: left out, as on Unplaced. */
  aside: number;
  loc?: PickedLocation;
};

// What the recap records, decided by what the human did with the pin — the
// Unplaced view's rule (flowSource there), with no card suggestion to seed
// from: a chapter's own place is either a guess with no coordinate (inferred
// from its neighbours) or a position a human chose by name.
function placeSource(f: PlaceFlow): GeotagSource {
  if (!f.loc) return "manual";
  return f.unverified.some((o) => distanceM(o, f.loc!) <= UNPLACED_RULES.move_m) ? "inferred" : "manual";
}

type Payload = {
  chapters: TimelineChapter[];
  granularity: PlaceGranularity;
  granularity_auto: boolean;
  spine: { year: number; month: number; count: number }[];
  undated: number;
};

const SOURCE_KEY = "winnow.timeline.source";
const ORDER_KEY = "winnow.timeline.order";

// Which way the stream reads. The derivation is chronological (chapters are
// cut and absorbed in time order, cf. lib/timeline.ts); the order is a reading
// choice applied on top, client-side, so flipping it costs no re-derivation.
// Newest first is the default: the maintainer opens the Timeline to find what
// he shot lately, and scrolling back is going back in time. A chapter's own
// strip and dates stay chronological either way — a stay reads as a story.
type Order = "newest" | "oldest";
const ORDERS: PickerOption<Order>[] = [
  { key: "newest", label: "Newest first", hint: "Start from the present and scroll back in time" },
  { key: "oldest", label: "Oldest first", hint: "Start from the first dated media and scroll forward" },
];
const isOrder = (s: string | null): s is Order => s === "newest" || s === "oldest";

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
  // A shared link's order wins; otherwise the last one chosen on this device.
  const [order, setOrder] = useState<Order>(() => {
    const o = searchParams.get("order");
    return isOrder(o) ? o : "newest";
  });
  const orderFromUrl = useRef(isOrder(searchParams.get("order")));
  useEffect(() => {
    if (orderFromUrl.current) return;
    try {
      const saved = localStorage.getItem(ORDER_KEY);
      if (isOrder(saved)) setOrder(saved);
    } catch {
      /* storage blocked: the default stands */
    }
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(ORDER_KEY, order);
    } catch {
      /* non-fatal */
    }
  }, [order]);

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
  // the Place dialog shared with Unplaced (see PlaceFlow) → POST
  // /api/assets/geotag. Nothing else in this page writes a position (cf.
  // docs/memory/architecture.md). `loc` arrives set when the chapter has a
  // place a human chose; an inferred one opens on an empty map.
  const [geotag, setGeotag] = useState<PlaceFlow | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const startGeotag = useCallback(async (chapter: TimelineChapter, loc?: PickedLocation) => {
    setGeotag({ chapter, assets: null, folders: [], places: [], unverified: [], aside: 0, loc });
    try {
      const [all, places] = await Promise.all([
        geotagTargets(
          chapter.sessions.map((s) => s.id),
          { from: chapter.started_at, to: chapter.ended_at },
        ),
        fetchNearPlaces(chapter.started_at, chapter.ended_at, "this chapter"),
      ]);
      const assets = all.filter((a) => !a.aside);
      if (!assets.some((a) => !a.gps)) {
        setGeotag(null);
        setNotice(
          all.length > assets.length
            ? "Nothing left to place here: the media with no position are screenshots, saved files or graded exports — Unplaced sets them aside."
            : "Every media in this chapter already has a position.",
        );
        return;
      }
      // One row per folder the chapter crosses, all ticked: the chapter is
      // the unit chosen, and a row is how one folder of it is left out.
      const folders: RecapFolder[] = chapter.sessions.map((s) => {
        const own = assets.filter((a) => a.session_id === s.id);
        const holes = own.filter((a) => !a.gps).length;
        return {
          id: s.id,
          name: s.name,
          detail: `${own.length.toLocaleString("en-GB")} media in this chapter · ${holes.toLocaleString("en-GB")} with no position`,
          primary: true,
        };
      });
      setGeotag((g) =>
        g && g.chapter.key === chapter.key
          ? {
              ...g,
              assets,
              folders: folders.filter((f) => assets.some((a) => a.session_id === f.id)),
              places,
              unverified: places.filter((p) => !p.verified).map((p) => ({ lat: p.lat, lon: p.lon })),
              aside: all.length - assets.length,
            }
          : g,
      );
    } catch (e) {
      setGeotag(null);
      setNotice(`Couldn’t list the chapter’s media: ${(e as Error).message}`);
    }
  }, []);

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
      sp.set("order", order);
      router.replace(`/timeline?${sp.toString()}`, { scroll: false });
    } catch {
      /* non-fatal */
    }
  }, [mode, gran, source, order, router]);

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

  // The chapters in reading order: the payload is chronological, the newest
  // first order is its reverse. Everything drawn in stream order (eras, the
  // spine, the jump target) reads this list, never data.chapters directly.
  const shown = useMemo(() => {
    const list = (data?.chapters ?? []).filter((c) => !onlyInferred || c.place_inferred);
    return order === "newest" ? [...list].reverse() : list;
  }, [data, onlyInferred, order]);

  // Chapters grouped under their year, for the sticky era bracket.
  const eras = useMemo(() => {
    const out: { year: number; chapters: TimelineChapter[] }[] = [];
    for (const ch of shown) {
      const y = new Date(ch.started_at).getUTCFullYear();
      const last = out[out.length - 1];
      if (last && last.year === y) last.chapters.push(ch);
      else out.push({ year: y, chapters: [ch] });
    }
    return out;
  }, [shown]);

  const streamRef = useRef<HTMLDivElement>(null);
  // The first chapter of that month ON SCREEN: newest first, that is the
  // month's latest, so the jump lands at the top of the month either way.
  const jumpTo = (year: number, month: number) => {
    const target = shown.find((c) => {
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
      <PageHeader
        title="Timeline"
        tabs={<LibrarySourceTabs source={source} onChange={setSource} />}
        trailing={
          data && (
            <span className="page-meta">
              {total.toLocaleString()} media · {data.chapters.length} chapters
            </span>
          )
        }
      />

      <div className="page-tools">
        <OptionPicker
          size="md"
          ariaLabel="Direction of time"
          options={ORDERS}
          value={order}
          onChange={setOrder}
        />
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
      </div>
      {notice && (
        <div className="page-tools" role="status">
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
            newestFirst={order === "newest"}
            activeKey={shown[0] ? monthKey(shown[0].started_at) : null}
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

      {geotag?.assets && (
        <GeotagRecapModal
          assets={geotag.assets}
          target={geotag.loc ?? null}
          source={placeSource(geotag)}
          sourceNote={placeNote(geotag)}
          onTargetChange={(loc) => setGeotag((g) => (g ? { ...g, loc } : g))}
          folders={geotag.folders}
          places={geotag.places}
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
      {geotag && !geotag.assets && (
        <div className="modal-overlay" role="presentation">
          <div className="modal">
            <LoadingState label="Listing the chapter’s media…" />
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

// The sentence under the position: where the pin came from, and what the
// recap will do with it. An inferred chapter says which neighbours named it,
// since the name is all the inference has — it carries no coordinate.
function placeNote(f: PlaceFlow): string | null {
  const parts: string[] = [];
  const ch = f.chapter;
  if (placeSource(f) === "inferred") {
    parts.push(
      "Taken from a spot that was itself an accepted suggestion: borrowed as offered, it stays one.",
    );
  } else if (ch.place_inferred && !f.loc) {
    parts.push(
      `No media in this chapter carries a position; its neighbours put it in “${ch.name}”. Click the map, search a place${f.places.length ? " or take one already placed nearby" : ""}.`,
    );
  } else if (ch.place_label && f.loc && f.loc.lat === ch.place_lat && f.loc.lon === ch.place_lon) {
    parts.push(`The place chosen for the chapter: “${ch.place_label}”. Move the pin if the media were shot elsewhere in it.`);
  }
  if (f.aside > 0)
    parts.push(
      `${f.aside.toLocaleString("en-GB")} screenshot${f.aside > 1 ? "s" : ""}, saved file${f.aside > 1 ? "s" : ""} or graded export${f.aside > 1 ? "s" : ""} left out, as on Unplaced.`,
    );
  return parts.length ? parts.join(" ") : null;
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
  newestFirst,
  activeKey,
  onJump,
}: {
  spine: { year: number; month: number; count: number }[];
  /** Read top-down in the stream's own direction, so the rail and the
   *  chapters it jumps to never run opposite ways. */
  newestFirst: boolean;
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
  if (newestFirst) rows.reverse();
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
