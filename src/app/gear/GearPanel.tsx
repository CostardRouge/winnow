"use client";

// The /gear shelf: every camera body the library was shot with and the glass it
// was used with, counted off the EXIF.
//
// EIGHT LAYOUTS, one dataset. The page used to have a single design built around
// generated line-art portraits of each body and lens; the drawings are gone (an
// illustrated shelf is somebody else's idea, and a drawing of a camera says
// nothing the library knows). What replaced them is the library's own numbers,
// read eight different ways — because "what have I shot with" is really several
// questions, and no single arrangement answers them all:
//
//   Stack     — where the frames went: one bar per body, split by its glass, and
//               one for the whole library. Proportion before number. The DEFAULT.
//   Index     — the inventory sheet. Everything aligned in one column set:
//               spec, usage meter, years, count. The densest of the eight.
//   Cards     — one card per body with the tally as the hero figure. The
//               at-a-glance read, and the one that survives a phone screen.
//   Blocks    — the kit as one surface, every area proportional to its frames.
//   Timeline  — bars on a shared year axis: when each piece was in service,
//               which body replaced which, what has not come out since 2021.
//   Coverage  — every lens on a logarithmic millimetre axis: what the bag
//               covers and where the hole is.
//   Marks     — focal length against aperture, sized by use: the bag's habit.
//   Record    — one printed sheet per body, in the display serif. The slow read.
//
// The layout is remembered, like the source tab: it is a way of reading the
// shelf, not a per-visit decision. The order below is the order of the toggle,
// and it runs composition → list → chart → sheet rather than by date added.
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
import { OptionPicker, type PickerOption } from "@/app/OptionPicker";
import { buildKit, num, SORTS, type Sort } from "./model";
import StackView from "./StackView";
import IndexView from "./IndexView";
import CardsView from "./CardsView";
import BlocksView from "./BlocksView";
import TimelineView from "./TimelineView";
import CoverageView from "./CoverageView";
import MarksView from "./MarksView";
import RecordView from "./RecordView";

type View =
  | "stack"
  | "index"
  | "cards"
  | "blocks"
  | "timeline"
  | "coverage"
  | "marks"
  | "record";

const VIEWS: PickerOption<View>[] = [
  { key: "stack", label: "Stack", hint: "Where the frames went — one bar per body, split by the glass that shot them." },
  { key: "index", label: "Index", hint: "The kit as an inventory sheet — spec, use, years, count in one column set." },
  { key: "cards", label: "Cards", hint: "One card per body, its tally as the hero figure, its glass listed inside." },
  { key: "blocks", label: "Blocks", hint: "The whole kit as one surface: every area is proportional to its media." },
  { key: "timeline", label: "Timeline", hint: "When each piece was in service, on one shared year axis." },
  { key: "coverage", label: "Coverage", hint: "Every lens on a logarithmic focal-length axis — what the bag covers, and where the hole is." },
  { key: "marks", label: "Marks", hint: "Focal length against aperture, sized by use — where the bag actually works." },
  { key: "record", label: "Record", hint: "One sheet per body: its specs, its odometer and its glass, set to be read." },
];

const isView = (v: string | null): v is View => VIEWS.some((x) => x.key === v);

/** The sort order, in the picker's shape — `SORTS` (model.ts) predates it and
 *  is shared with nothing else, so the mapping stays here rather than churn it. */
const SORT_OPTIONS: PickerOption<Sort>[] = SORTS.map((s) => ({
  key: s.key,
  label: s.label,
  hint: s.title,
}));

// The chosen half of the library and the chosen layout both stick between
// visits — they are ways of working ("I live in Incoming", "I read the sheet"),
// not per-visit decisions.
const SOURCE_KEY = "winnow.gear.source";
const VIEW_KEY = "winnow.gear.view";

/** Restore / persist the layout. Seeded in an effect, like the source hook, so
 *  the first render matches the server's and nothing flashes. A visitor with a
 *  remembered choice keeps it; only a fresh one lands on Stack. */
function useStoredView(): [View, (v: View) => void] {
  const [view, setView] = useState<View>("stack");
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
      {/* Eight options: the picker draws itself as a menu (cf. OptionPicker),
          which is also where each layout's sentence finally becomes readable on
          a touch screen. Two options: it stays a segmented row. */}
      <OptionPicker options={VIEWS} value={view} onChange={setView} ariaLabel="Layout" />
      <OptionPicker
        options={SORT_OPTIONS}
        value={sort}
        onChange={setSort}
        ariaLabel="Sort"
      />
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
      <p className="gear-caption">{current.hint}</p>
      <Layout view={view} kit={kit} />
    </div>
  );
}

function Layout({ view, kit }: { view: View; kit: ReturnType<typeof buildKit> }) {
  switch (view) {
    case "index":
      return <IndexView kit={kit} />;
    case "cards":
      return <CardsView kit={kit} />;
    case "blocks":
      return <BlocksView kit={kit} />;
    case "timeline":
      return <TimelineView kit={kit} />;
    case "coverage":
      return <CoverageView kit={kit} />;
    case "marks":
      return <MarksView kit={kit} />;
    case "record":
      return <RecordView kit={kit} />;
    default:
      return <StackView kit={kit} />;
  }
}
