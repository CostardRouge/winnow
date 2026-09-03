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
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { fetchJson } from "@/lib/fetchJson";
import type {
  ChapterMode,
  PlaceGranularity,
  TimelineChapter,
} from "@/lib/timeline";
import { EmptyState, Icons, LoadingState } from "@/app/ui";
import {
  LibrarySourceTabs,
  useStoredLibrarySource,
  type LibrarySource,
} from "@/app/LibrarySourceTabs";
import MediaViewer, { type ViewerItem } from "@/app/MediaViewer";
import ViewerActions from "@/app/ViewerActions";
import type { GalleryAsset } from "@/app/gallery/VirtualGrid";
import ChapterCard, { type Row } from "./ChapterCard";

type Payload = {
  chapters: TimelineChapter[];
  granularity: PlaceGranularity;
  granularity_auto: boolean;
  spine: { year: number; month: number; count: number }[];
  undated: number;
};

const SOURCE_KEY = "winnow.timeline.source";

const MODES: { key: ChapterMode; label: string; title: string }[] = [
  { key: "place", label: "Lieu", title: "Un chapitre par lieu, quelle que soit la durée" },
  { key: "time", label: "Temps", title: "Un chapitre par période continue de prise de vue" },
  { key: "hybrid", label: "Hybride", title: "Changement de lieu ou longue absence, miettes absorbées" },
];

const GRAN_LABEL: Record<PlaceGranularity, string> = {
  city: "Ville",
  county: "Département",
  region: "Région",
};
const GRAN_CYCLE: (PlaceGranularity | "auto")[] = ["auto", "region", "county", "city"];

const MONTHS_SHORT = ["jan", "fév", "mar", "avr", "mai", "jui", "jul", "aoû", "sep", "oct", "nov", "déc"];

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
  const [error, setError] = useState<string | null>(null);
  // Bumped by "Réessayer": same query, fresh request.
  const [attempt, setAttempt] = useState(0);

  // The viewer navigates within one chapter's loaded tiles: crossing into the
  // next chapter is a scroll away, and a flattened list would hand the viewer
  // items whose tiles never loaded.
  const [viewer, setViewer] = useState<{ rows: Row[]; index: number } | null>(null);

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
  }, [query, attempt]);

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
    for (const ch of data?.chapters ?? []) {
      const y = new Date(ch.started_at).getUTCFullYear();
      const last = out[out.length - 1];
      if (last && last.year === y) last.chapters.push(ch);
      else out.push({ year: y, chapters: [ch] });
    }
    return out;
  }, [data]);

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
          ? "Découpage choisi pour la période affichée — cliquer pour l'épingler"
          : "Découpage épinglé — cliquer pour changer de niveau"
      }
      onClick={() => setGran(GRAN_CYCLE[(GRAN_CYCLE.indexOf(gran) + 1) % GRAN_CYCLE.length])}
    >
      Découpage · {GRAN_LABEL[data.granularity]}
      <span className="chip-count">{gran === "auto" ? "auto" : "épinglé"}</span>
    </button>
  ) : null;

  return (
    <div className="app-shell">
      <div className="topbar">
        <h1>Timeline</h1>
        <span className="hint max-sm:hidden">la bibliothèque lue comme un récit</span>
        <span className="spacer" />
        {data && (
          <span className="hint" style={{ fontFamily: "var(--font-mono)" }}>
            {total.toLocaleString()} médias · {data.chapters.length} chapitres
          </span>
        )}
      </div>

      <div className="gallery-controls">
        <div className="tabs" role="group" aria-label="Règle de découpage">
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
            title="Médias sans date de prise de vue : ils ne peuvent pas être placés sur la timeline et restent visibles dans la grille"
          >
            {Icons.alert} {data.undated.toLocaleString()} sans date
          </span>
        )}
        <span className="spacer" />
        <LibrarySourceTabs source={source} onChange={setSource} />
      </div>

      <div className="tl-body">
        <div className="tl-stream" ref={streamRef}>
          {loading && !data && <LoadingState label="Lecture de la bibliothèque…" />}
          {error && (
            <div className="error-box">
              <span>{error}</span>
              <button className="btn btn-sm" onClick={() => setAttempt((n) => n + 1)}>
                Réessayer
              </button>
            </div>
          )}
          {data && data.chapters.length === 0 && !loading && (
            <EmptyState
              title="Rien à raconter ici"
              hint={
                source === "gallery"
                  ? "La Gallery ne contient aucun média daté."
                  : "Aucun média daté dans cette moitié de la bibliothèque."
              }
            />
          )}
          {eras.map((era) => (
            <section key={era.year}>
              <div className="tl-era">
                <span className="tl-era-name">{era.year}</span>
                <span className="tl-era-meta">
                  {era.chapters.length} chapitre{era.chapters.length > 1 ? "s" : ""} ·{" "}
                  {era.chapters.reduce((n, c) => n + c.count, 0).toLocaleString()} médias
                </span>
              </div>
              {era.chapters.map((ch) => (
                <ChapterCard
                  key={ch.key}
                  chapter={ch}
                  gridHref={gridHref(source)}
                  onOpen={(rows, index) => setViewer({ rows, index })}
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
      </div>

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
    <div className="tl-spine" aria-label="Mois">
      {rows.map((r) => {
        const head = r.year !== year ? <div className="tl-spine-year">{r.year}</div> : null;
        year = r.year;
        const active = activeKey === `${r.year}-${r.month}`;
        return (
          <div key={`${r.year}-${r.month}`}>
            {head}
            <button
              className={`tl-spine-row${active ? " active" : ""}`}
              title={`${r.count.toLocaleString()} médias`}
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
