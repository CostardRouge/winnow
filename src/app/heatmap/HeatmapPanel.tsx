"use client";

// The Heatmap — when and where the library was actually made, read four ways.
//
// ## Why four readings behind one segmented control
//
// Each answers "when × where" with a different thing given up, and none of them
// is right for every question:
//
//   Both     — calendar above, binned map below, cross-filtered. The only one
//              that answers "where was I in the summers of 2023–2025".
//   Matrix   — places down, months across. No map at all: the crossing becomes
//              a single object read like a timetable. Gives up geography.
//   Map      — the map at full width with a month scrubber under it. Best for
//              the question about absence ("where have I not been back to"),
//              and the only one that is comfortable on a phone.
//   Tinted   — one calendar, each day wearing its place's colour. Geography as
//              texture rather than a panel; the cheapest reading, and the one
//              a run of matching feet makes into a trip at a glance.
//
// They share ONE measure (the control above them) so the panels are never
// colouring different questions, and ONE ramp so a rung means the same thing
// everywhere. That sharing is the design; the four layouts are variations on it.
//
// ## State lives in the URL
//
// `view`, `measure`, `gran`, `source`, `from`/`to` (the brushed span) and
// `place` (the picked bin) are all query params — the gallery's rule and the
// Timeline's. A reading you cannot link to is a reading you cannot show anyone.
//
// ## What a fetch costs
//
// Two reads, and neither is re-fetched by switching view or measure: the days
// payload is one row per capture date, the places payload is a fixed number of
// places by month. Only a brushed span (which narrows the places) or a picked
// bin (which narrows the days) goes back to the server, and the brush is
// debounced so a drag is one request, not sixty.
import { useCallback, useEffect, useMemo, useState } from "react";
import dynamicImport from "next/dynamic";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { fetchJson } from "@/lib/fetchJson";
import { Icons, Spinner } from "../ui";
import {
  LibrarySourceTabs,
  useStoredLibrarySource,
  type LibrarySource,
} from "../LibrarySourceTabs";
import type { HeatDays, HeatPlaces } from "@/lib/heat";
import {
  DEFAULT_MEASURE,
  MEASURES,
  RATE_FLOOR,
  measureById,
  rungVar,
} from "@/lib/heatScale";
import HeatGrid, { byMonth, type Granularity } from "./HeatGrid";
import HeatMatrix, { type MatrixSort } from "./HeatMatrix";
import HeatRibbon from "./HeatRibbon";

// Leaflet (JS + CSS) is a heavy dependency two of the four readings need — the
// gallery's MapView is loaded the same way so it never rides in the main
// bundle. SSR off: it touches `window` on mount.
const HeatBins = dynamicImport(() => import("./HeatBins"), {
  ssr: false,
  loading: () => <div className="heat-map is-loading" />,
});

type ViewId = "both" | "matrix" | "map" | "tinted";

const VIEWS: { id: ViewId; label: string; hint: string }[] = [
  { id: "both", label: "Both", hint: "Calendar and map, cross-filtered" },
  { id: "matrix", label: "Matrix", hint: "Places down, months across" },
  { id: "map", label: "Map", hint: "The map at full width, months on a rail" },
  { id: "tinted", label: "Tinted", hint: "One calendar, place as a stripe" },
];
const isView = (s: string | null): s is ViewId => VIEWS.some((v) => v.id === s);
const isSource = (s: string | null): s is LibrarySource =>
  s === "all" || s === "incoming" || s === "gallery";

// How many places get a tint of their own; the rest read as "elsewhere".
// Four is the honest ceiling — past that the hues stop being tellable apart,
// and a stripe is never the only carrier (every one is named in the key).
//
// The BUSIEST place deliberately gets none. It is home for most libraries, so
// tinting it stripes four cells in five and the trips stop reading as runs —
// which is the whole point of the tinted calendar. Leaving it bare is a rule,
// not a hidden one: the key names the place it applies to.
const TINTS = 4;

const SOURCE_KEY = "winnow.heatmap.source";
const kindFor = (s: LibrarySource) =>
  s === "incoming" ? "incoming" : s === "gallery" ? "final" : null;

const nf = new Intl.NumberFormat("en-US");
const pretty = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${Number(d)}/${m}/${y}`;
};

export default function HeatmapPanel() {
  const router = useRouter();
  const sp = useSearchParams();

  const urlView = sp?.get("view") ?? null;
  const view: ViewId = isView(urlView) ? urlView : "both";
  const measure = measureById(sp?.get("measure") ?? DEFAULT_MEASURE);
  const gran: Granularity = sp?.get("gran") === "week" ? "week" : "day";
  const from = sp?.get("from") ?? null;
  const to = sp?.get("to") ?? null;
  const span: [string, string] | null = from && to ? [from, to] : null;
  const placeParam = sp?.get("place");
  const place = placeParam ? Number.parseInt(placeParam, 10) : null;

  const [source, setSource] = useStoredLibrarySource(
    SOURCE_KEY,
    isSource(sp?.get("source") ?? null) ? (sp!.get("source") as LibrarySource) : undefined,
  );
  const [sort, setSort] = useState<MatrixSort>("volume");

  const [days, setDays] = useState<HeatDays | null>(null);
  const [places, setPlaces] = useState<HeatPlaces | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // One writer for the whole URL state, so a change never drops another param.
  const patch = useCallback(
    (next: Record<string, string | null>) => {
      const q = new URLSearchParams(sp?.toString() ?? "");
      for (const [k, v] of Object.entries(next)) {
        if (v === null) q.delete(k);
        else q.set(k, v);
      }
      router.replace(`/heatmap?${q.toString()}`, { scroll: false });
    },
    [router, sp],
  );

  const setSpan = useCallback(
    (s: [string, string] | null) =>
      patch(s ? { from: s[0], to: s[1] } : { from: null, to: null }),
    [patch],
  );

  const baseQuery = useCallback(() => {
    const q = new URLSearchParams();
    const kind = kindFor(source);
    if (kind) q.set("kind", kind);
    return q;
  }, [source]);

  // The calendar always holds every day (the brush only dims), so it is
  // re-fetched for the source and for a picked bin — never for the brush.
  useEffect(() => {
    let alive = true;
    const q = baseQuery();
    if (place != null) q.set("place", String(place));
    setBusy(true);
    fetchJson<HeatDays>(`/api/assets/heat/days?${q.toString()}`)
      .then((d) => { if (alive) { setDays(d); setError(null); } })
      .catch((e) => { if (alive) setError((e as Error).message); })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [baseQuery, place]);

  // The places read narrows to the brushed span. Debounced: a drag across the
  // calendar changes `span` on every cell it crosses.
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      const q = baseQuery();
      if (span) { q.set("date_from", span[0]); q.set("date_to", span[1]); }
      fetchJson<HeatPlaces>(`/api/assets/heat/places?${q.toString()}`)
        .then((d) => { if (alive) { setPlaces(d); setError(null); } })
        .catch((e) => { if (alive) setError((e as Error).message); });
    }, 220);
    return () => { alive = false; clearTimeout(t); };
  }, [baseQuery, span?.[0], span?.[1]]);

  const months = useMemo(() => byMonth(days?.days ?? []), [days]);
  // The tint slots are the busiest places, taken from the places read — the
  // two payloads are ordered by the same rule, so the calendar's stripes, the
  // matrix's dots and the map's bins all name the same four.
  const home = places?.places[0] ?? null;
  const tints = useMemo(
    () =>
      (places?.places ?? [])
        .slice(1, TINTS + 1)
        .map((p) => ({ id: p.id, name: p.name })),
    [places],
  );
  const tintIds = useMemo(() => tints.map((t) => t.id), [tints]);

  // Hand off to the grid the same way the Calendar and the Map do — a date
  // range and/or a place, as ordinary cumulative filters. The heatmap invents
  // no filter of its own.
  const gridHref = useMemo(() => {
    const q = new URLSearchParams();
    if (span) { q.set("date_from", span[0]); q.set("date_to", span[1]); }
    const p = places?.places.find((x) => x.id === place);
    if (p) q.set("place_city", p.name);
    const base = source === "gallery" ? "/library/gallery" : "/library/incoming/grid";
    return `${base}${q.toString() ? `?${q.toString()}` : ""}`;
  }, [span, place, places, source]);

  const filtered = Boolean(span || place != null);
  const pickedPlace = places?.places.find((x) => x.id === place) ?? null;

  return (
    <div className="app-shell">
      <div className="topbar">
        <h1>Heatmap</h1>
        <span className="hint max-sm:hidden">when and where the library was made</span>
      </div>

      <div className="shell-head">
        <div className="shell-head-row">
          <div className="view-toggle" role="group" aria-label="Reading">
            {VIEWS.map((v) => (
              <button
                key={v.id}
                className={`view-btn${view === v.id ? " active" : ""}`}
                aria-pressed={view === v.id}
                title={v.hint}
                onClick={() => patch({ view: v.id })}
              >
                {v.label}
              </button>
            ))}
          </div>
          <span className="spacer" />
          <LibrarySourceTabs source={source} onChange={setSource} />
        </div>

        <div className="shell-head-row heat-controls">
          <span className="heat-lab">Measure</span>
          <div className="view-toggle" role="group" aria-label="Measure">
            {MEASURES.map((m) => (
              <button
                key={m.id}
                className={`view-btn${measure.id === m.id ? " active" : ""}`}
                aria-pressed={measure.id === m.id}
                onClick={() => patch({ measure: m.id })}
              >
                {m.label}
              </button>
            ))}
          </div>

          {(view === "both" || view === "tinted") && (
            <div className="view-toggle" role="group" aria-label="Granularity">
              {(["day", "week"] as Granularity[]).map((g) => (
                <button
                  key={g}
                  className={`view-btn${gran === g ? " active" : ""}`}
                  aria-pressed={gran === g}
                  title={g === "day" ? "One cell per day" : "One cell per week — a decade at a glance"}
                  onClick={() => patch({ gran: g })}
                >
                  {g === "day" ? "Day" : "Week"}
                </button>
              ))}
            </div>
          )}

          <span className="spacer" />
          <div className="heat-legend" aria-hidden>
            <span>{measure.lo}</span>
            {[0, 1, 2, 3, 4].map((r) => (
              <i key={r} style={{ background: rungVar(r) }} />
            ))}
            <span>{measure.hi}</span>
          </div>
        </div>

        {/* What is currently narrowing the view, and the way out of it. */}
        {filtered && (
          <div className="shell-head-row heat-filters" role="status">
            {span && (
              <span className="chip active">
                {span[0] === span[1] ? pretty(span[0]) : `${pretty(span[0])} → ${pretty(span[1])}`}
                <button
                  className="chip-x"
                  aria-label="Clear the date span"
                  onClick={() => setSpan(null)}
                >
                  ×
                </button>
              </span>
            )}
            {pickedPlace && (
              <span className="chip active">
                {pickedPlace.name}
                <button
                  className="chip-x"
                  aria-label="Clear the place"
                  onClick={() => patch({ place: null })}
                >
                  ×
                </button>
              </span>
            )}
            <span className="spacer" />
            <Link className="btn btn-sm" href={gridHref}>
              {Icons.photos}
              Open in the grid
            </Link>
          </div>
        )}
      </div>

      <div className="pipeline-body">
        {error && (
          <div className="error-box">
            <span>Couldn’t read the heatmap: {error}</span>
          </div>
        )}

        {!days ? (
          <Spinner />
        ) : days.days.length === 0 ? (
          <p className="hint">
            Nothing dated in this half of the library yet — the heatmap reads
            <code> capture_date</code>, which the indexer fills from EXIF.
          </p>
        ) : (
          <div className={`heat-body${busy ? " is-busy" : ""}`}>
            {(view === "both" || view === "tinted") && (
              <section className="heat-panel">
                <header className="heat-panel-head">
                  <span className="heat-panel-title">
                    Calendar · {gran === "day" ? "one cell per day" : "one cell per week"}
                  </span>
                  <span className="spacer" />
                  <span className="hint heat-note">
                    UTC days — <code>capture_date</code> is a UTC column and Winnow
                    keeps no per-asset timezone
                  </span>
                </header>
                <HeatGrid
                  days={days.days}
                  measure={measure}
                  granularity={gran}
                  span={span}
                  onSpan={view === "both" ? setSpan : undefined}
                  tint={view === "tinted"}
                  tints={tints}
                />
                {view === "tinted" && (
                  <div className="heat-key">
                    {tints.map((t, i) => (
                      <span key={t.id} className="heat-keyitem">
                        <i style={{ background: `var(--heat-place-${i})` }} aria-hidden />
                        {t.name}
                      </span>
                    ))}
                    <span className="heat-keyitem is-muted">
                      <i style={{ background: "var(--color-border-strong)" }} aria-hidden />
                      {home
                        ? `no stripe — ${home.name} (your busiest place), elsewhere, or no position`
                        : "no stripe — elsewhere or no position"}
                    </span>
                  </div>
                )}
                {view === "both" && (
                  <p className="hint heat-note">
                    Drag across the calendar to brush a span — the map below
                    redraws to only those days.
                  </p>
                )}
              </section>
            )}

            {(view === "both" || view === "map") && (
              <section className="heat-panel">
                <header className="heat-panel-head">
                  <span className="heat-panel-title">
                    Places
                    {places?.precisionM
                      ? ` · ${Math.round(places.precisionM / 1000)} km bins`
                      : ""}
                  </span>
                  <span className="spacer" />
                  {places && places.untagged.c > 0 && (
                    <span className="hint heat-note">
                      {nf.format(places.untagged.c)} frames with no position — counted, never on the map
                    </span>
                  )}
                </header>
                {places ? (
                  <HeatBins
                    places={places.places}
                    measure={measure}
                    selected={place}
                    onSelect={(id) => patch({ place: id === null ? null : String(id) })}
                    height={view === "map" ? 460 : 340}
                  />
                ) : (
                  <div className="heat-map is-loading" />
                )}
                <p className="hint heat-note">
                  One mark per geocoding cell (<code>places.precision_m</code>),
                  sized and coloured by the measure. The mark keeps its size in
                  pixels rather than covering the cell on the ground, so a bin
                  stays readable at world zoom; bins do not refine on zoom
                  either — the cell size is what reverse geocoding stored.
                </p>
              </section>
            )}

            {view === "map" && (
              <section className="heat-panel">
                <header className="heat-panel-head">
                  <span className="heat-panel-title">Months</span>
                  <span className="spacer" />
                  <span className="hint heat-note">Click a bar to hold the map to that month</span>
                </header>
                <HeatRibbon months={months} measure={measure} span={span} onSpan={setSpan} />
              </section>
            )}

            {view === "matrix" && (
              <section className="heat-panel">
                <header className="heat-panel-head">
                  <span className="heat-panel-title">Places × months</span>
                  <span className="spacer" />
                  <span className="hint heat-note">Click a cell to hold that month</span>
                </header>
                {places ? (
                  <HeatMatrix
                    data={places}
                    measure={measure}
                    sort={sort}
                    onSort={setSort}
                    span={span}
                    onSpan={setSpan}
                    tintIds={tintIds}
                  />
                ) : (
                  <Spinner />
                )}
              </section>
            )}

            <p className="hint heat-foot">
              {days.undated.c > 0 && (
                <>
                  {nf.format(days.undated.c)} frames carry no capture date and are
                  in none of the cells above.{" "}
                </>
              )}
              {measure.id === "rate" && (
                <>
                  A cell under {RATE_FLOOR} frames has no keeper rate and is drawn
                  neutral — four frames and two picks is not a 50 % day.
                </>
              )}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
