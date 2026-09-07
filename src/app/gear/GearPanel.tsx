"use client";

// The /gear shelf: every camera body the library was shot with and the glass it
// was used with, counted off the EXIF.
//
// FOUR LAYOUTS, one dataset. The page used to have a single design built around
// generated line-art portraits of each body and lens; the drawings are gone (an
// illustrated shelf is somebody else's idea, and a drawing of a camera says
// nothing the library knows). What replaced them is the library's own numbers,
// read four different ways — because "what have I shot with" is really four
// questions, and no single arrangement answers them all:
//
//   Index     — the inventory sheet. Everything aligned in one column set:
//               spec, usage meter, years, count. The dense, scannable default.
//   Cards     — one card per body with the tally as the hero figure. The
//               at-a-glance read, and the one that survives a phone screen.
//   Timeline  — bars on a shared year axis: when each piece was in service,
//               which body replaced which, what has not come out since 2021.
//   Coverage  — every lens on a logarithmic millimetre axis: what the bag
//               covers and where the hole is.
//
// The layout is remembered, like the source tab: it is a way of reading the
// shelf, not a per-visit decision.
//
// A gear entry is a shortcut, not a museum label — following a body opens the
// grid filtered on it, following a lens opens the same grid narrowed to that
// body AND that lens, so "what did I shoot on the 56 on the A7C" is one click
// away in every layout.
//
// Which grid? The library has two halves — Incoming (still to cull) and the
// Gallery (finalized exports) — and most gear has frames in BOTH. Merging them
// would make every entry lie in one direction or the other: the count would
// include media the linked grid can't show. So the shelf carries the shared
// Incoming/Gallery/All picker (cf. LibrarySourceTabs.tsx), and the choice
// drives both the counts and where every entry points (cf. lib/gear.ts, which
// tallies per source). "All" sums both — its entries link to whichever half the
// piece of gear actually has frames in, Incoming first (effectiveLibrarySource).
import { useEffect, useMemo, useState } from "react";
import { fetchJson } from "@/lib/fetchJson";
import type { GearResponse } from "@/lib/gearTypes";
import { EmptyState, Icons, LoadingState } from "@/app/ui";
import { LibrarySourceTabs, useStoredLibrarySource } from "@/app/LibrarySourceTabs";
import { buildKit, num, SORTS, type Sort } from "./model";
import IndexView from "./IndexView";
import CardsView from "./CardsView";
import TimelineView from "./TimelineView";
import CoverageView from "./CoverageView";

type View = "index" | "cards" | "timeline" | "coverage";

const VIEWS: { key: View; label: string; blurb: string }[] = [
  { key: "index", label: "Index", blurb: "The kit as an inventory sheet — spec, use, years, count in one column set." },
  { key: "cards", label: "Cards", blurb: "One card per body, its tally as the hero figure, its glass listed inside." },
  { key: "timeline", label: "Timeline", blurb: "When each piece was in service, on one shared year axis." },
  { key: "coverage", label: "Coverage", blurb: "Every lens on a logarithmic focal-length axis — what the bag covers, and where the hole is." },
];

const isView = (v: string | null): v is View => VIEWS.some((x) => x.key === v);

// The chosen half of the library and the chosen layout both stick between
// visits — they are ways of working ("I live in Incoming", "I read the sheet"),
// not per-visit decisions.
const SOURCE_KEY = "winnow.gear.source";
const VIEW_KEY = "winnow.gear.view";

/** Restore / persist the layout. Seeded in an effect, like the source hook, so
 *  the first render matches the server's and nothing flashes. */
function useStoredView(): [View, (v: View) => void] {
  const [view, setView] = useState<View>("index");
  useEffect(() => {
    const saved = localStorage.getItem(VIEW_KEY);
    if (isView(saved)) setView(saved);
  }, []);
  useEffect(() => {
    localStorage.setItem(VIEW_KEY, view);
  }, [view]);
  return [view, setView];
}

export default function GearPanel() {
  const [data, setData] = useState<GearResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>("used");
  const [source, setSource] = useStoredLibrarySource(SOURCE_KEY);
  const [view, setView] = useStoredView();

  useEffect(() => {
    fetchJson<GearResponse>("/api/gear")
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load"));
  }, []);

  // One derivation for every layout: the tallies, the links and the weights are
  // decided here so two views can never disagree about them (cf. model.ts).
  const kit = useMemo(
    () => buildKit(data?.cameras ?? [], source, sort),
    [data, source, sort],
  );

  if (error) {
    return (
      <div className="empty-state error" role="alert">
        {error}
      </div>
    );
  }
  if (!data) return <LoadingState label="Reading the EXIF…" />;

  const current = VIEWS.find((v) => v.key === view) ?? VIEWS[0];
  // Empty tab vs empty library: only the second one is "no gear yet".
  const otherTotal = (data.cameras ?? []).reduce(
    (s, c) => s + c.incoming.count + c.gallery.count,
    0,
  );

  const head = (
    <div className="gear-head">
      <LibrarySourceTabs source={source} onChange={setSource} />
      <span className="hint">
        {kit.bodies.length} {kit.bodies.length === 1 ? "body" : "bodies"} ·{" "}
        {kit.lensCount} {kit.lensCount === 1 ? "lens" : "lenses"} ·{" "}
        {num(kit.totalFrames)} media
      </span>
      <span className="spacer" />
      <div className="view-toggle" role="group" aria-label="Layout">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            className={`view-btn${view === v.key ? " active" : ""}`}
            onClick={() => setView(v.key)}
            aria-pressed={view === v.key}
            title={v.blurb}
          >
            {v.label}
          </button>
        ))}
      </div>
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
  );

  if (kit.bodies.length === 0) {
    return (
      <div className="gear-shelf">
        {head}
        <EmptyState
          icon={Icons.photos}
          title={otherTotal > 0 ? "Nothing here yet" : "No gear yet"}
          hint={
            otherTotal > 0
              ? source === "all"
                ? "No media carries camera EXIF."
                : `No media in ${source === "gallery" ? "the Gallery" : "Incoming"} carry camera EXIF — try another tab.`
              : "Cameras and lenses appear here as soon as indexed media carry EXIF maker/model tags."
          }
        />
      </div>
    );
  }

  return (
    <div className="gear-shelf">
      {head}
      {/* The layouts are different enough that the toggle alone doesn't say what
          it just did — one line does. */}
      <p className="gear-caption">{current.blurb}</p>
      <Layout view={view} kit={kit} />
    </div>
  );
}

function Layout({ view, kit }: { view: View; kit: ReturnType<typeof buildKit> }) {
  switch (view) {
    case "cards":
      return <CardsView kit={kit} />;
    case "timeline":
      return <TimelineView kit={kit} />;
    case "coverage":
      return <CoverageView kit={kit} />;
    default:
      return <IndexView kit={kit} />;
  }
}
