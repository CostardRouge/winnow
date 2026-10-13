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
//
// WHOSE CAMERA (migration 0053, cf. ownership.tsx). The shelf is also where a
// body is claimed: a mark before every name, Group (by owner, kind, or not at
// all) and Show in the band, and a sort deck for the bodies nobody answered
// for yet. Grouping does not teach the eight layouts anything: each section is
// a Kit of its own bodies, built by the same buildKit and drawn by the same
// layout — so "Mine" reads exactly as the whole shelf does, only narrower.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { fetchJson } from "@/lib/fetchJson";
import type { GearCamera, GearOwner, GearResponse } from "@/lib/gearTypes";
import { CAMERA_KINDS, cameraKind } from "@/lib/gearSpec";
import { EmptyState, Icons, LoadingState } from "@/app/ui";
import PageHeader from "@/app/PageHeader";
import { LibrarySourceTabs, useStoredLibrarySource } from "@/app/LibrarySourceTabs";
import { OptionPicker, type PickerOption } from "@/app/OptionPicker";
import { buildKit, num, SORTS, type Kit, type KitBody, type Sort } from "./model";
import { OwnershipProvider, SortDeck, WhoseDialog } from "./ownership";
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
// Grouping is remembered too — a way of reading the shelf. Show is NOT: a
// remembered filter is a shelf that silently holds less than it says
// (docs/SILENT-LIMITS-AUDIT.md), so every visit opens on everything.
const GROUP_KEY = "winnow.gear.group";

type Group = "owner" | "kind" | "none";
const GROUPS: PickerOption<Group>[] = [
  { key: "owner", label: "Owner", hint: "Mine, someone else’s, not a camera, not sorted" },
  { key: "kind", label: "Kind", hint: "Mirrorless, phones, drones…" },
  { key: "none", label: "None", hint: "One shelf" },
];
const isGroup = (v: string | null): v is Group => GROUPS.some((g) => g.key === v);

type Show = "all" | "mine" | "other" | "unsorted" | "none" | "named";
const SHOWS: PickerOption<Show>[] = [
  { key: "all", label: "All", hint: "Every body" },
  { key: "mine", label: "Mine", hint: "The bodies you own or owned" },
  { key: "other", label: "Others’", hint: "Friends’ cameras, photographers" },
  { key: "unsorted", label: "Not sorted", hint: "Nobody answered for them yet" },
  { key: "none", label: "Not a camera", hint: "Apps, webcams" },
  { key: "named", label: "Named by hand", hint: "No file names them" },
];

const ownerOf = (c: GearCamera) => c.owner?.owner ?? "unsorted";

// The sections Group: Owner cuts the shelf into, in this order.
const OWNER_SECTIONS: { key: string; title: string }[] = [
  { key: "mine", title: "Mine" },
  { key: "other", title: "Someone else’s" },
  { key: "unsorted", title: "Not sorted yet" },
  { key: "none", title: "Not a camera" },
];

function useStoredGroup(): [Group, (g: Group) => void] {
  const [group, setGroup] = useState<Group>("owner");
  useEffect(() => {
    const saved = localStorage.getItem(GROUP_KEY);
    if (isGroup(saved)) setGroup(saved);
  }, []);
  useEffect(() => {
    localStorage.setItem(GROUP_KEY, group);
  }, [group]);
  return [group, setGroup];
}

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
  const [group, setGroup] = useStoredGroup();
  const [show, setShow] = useState<Show>("all");
  const [editing, setEditing] = useState<KitBody | null>(null);
  const [deck, setDeck] = useState<KitBody[] | null>(null);

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

  // The shelf as shown: Show narrows the bodies, Group cuts them into
  // sections, and each section is a Kit of its own (see the header).
  const sections = useMemo(() => {
    const shown = (data?.cameras ?? []).filter((c) =>
      show === "all" ? true : show === "named" ? c.named : ownerOf(c) === show,
    );
    const section = (key: string, title: string | null, cams: GearCamera[]) => {
      const k: Kit = { ...buildKit(cams, source, sort), scope: title };
      return { key, title, kit: k };
    };
    let out: { key: string; title: string | null; kit: Kit }[];
    if (group === "owner") {
      out = OWNER_SECTIONS.map((s) =>
        section(s.key, s.title, shown.filter((c) => ownerOf(c) === s.key)),
      );
    } else if (group === "kind") {
      const kinds = [...new Set(shown.map((c) => cameraKind(c.name, c.named)))];
      out = kinds.map((k) =>
        section(k, CAMERA_KINDS[k], shown.filter((c) => cameraKind(c.name, c.named) === k)),
      );
      // Busiest kind first, as the bodies inside it are — but "Unknown type"
      // is not a kind, it is what is left: it goes last whatever its size.
      out.sort(
        (a, b) =>
          Number(a.key === "unknown") - Number(b.key === "unknown") ||
          b.kit.totalFrames - a.kit.totalFrames,
      );
    } else {
      out = [section("all", null, shown)];
    }
    return out.filter((s) => s.kit.bodies.length > 0);
  }, [data, show, group, source, sort]);

  // A write answered: the row the server returned replaces the body's owner in
  // place, so the shelf re-groups without re-reading the EXIF aggregate.
  const applyOwner = useCallback((device: string, owner: GearOwner | null) => {
    setData((d) =>
      d && { ...d, cameras: d.cameras.map((c) => (c.name === device ? { ...c, owner } : c)) },
    );
  }, []);
  const ownership = useMemo(
    () => ({ people: data?.people ?? [], edit: (b: KitBody) => setEditing(b) }),
    [data?.people],
  );
  // The deck's queue: the unsorted bodies of the half being looked at.
  const unsorted = kit.bodies.filter((b) => !b.owner);
  const mine = kit.bodies.filter((b) => b.owner?.owner === "mine");

  // The header is the PANEL's, not the page's: its tabs are the library-source
  // picker, and that state lives here. Every return goes through this so the
  // header — and the picker — is there while the EXIF is still being read,
  // rather than appearing a beat later once the data lands.
  const shell = (body: ReactNode) => (
    <>
      <PageHeader
        title="Gear"
        tabs={<LibrarySourceTabs source={source} onChange={setSource} />}
      />
      {body}
    </>
  );

  // The panel owns the page below the header: the toolbar band, flush under
  // it, then the padded scrolling shelf — so the band is the same band every
  // other section wears rather than a row inside the padding.
  if (error) {
    return shell(
      <div className="pipeline-body">
        <div className="empty-state error" role="alert">
          {error}
        </div>
      </div>,
    );
  }
  if (!data) {
    return shell(
      <div className="pipeline-body">
        <LoadingState label="Reading the EXIF…" />
      </div>,
    );
  }

  const current = VIEWS.find((v) => v.key === view) ?? VIEWS[0];
  // Empty tab vs empty library: only the second one is "no gear yet".
  const otherTotal = (data.cameras ?? []).reduce(
    (s, c) => s + c.incoming.count + c.gallery.count,
    0,
  );

  const head = (
    <div className="page-tools gear-head">
      <span className="hint">
        {kit.bodies.length} {kit.bodies.length === 1 ? "body" : "bodies"} ·{" "}
        {kit.lensCount} {kit.lensCount === 1 ? "lens" : "lenses"} ·{" "}
        {num(kit.totalFrames)} media
        {mine.length > 0 && <> · {mine.length} yours</>}
        {unsorted.length > 0 && (
          <>
            {" · "}
            <button type="button" className="link-btn" onClick={() => setDeck(unsorted)}>
              {unsorted.length} not sorted
            </button>
          </>
        )}
      </span>
      <span className="spacer" />
      <OptionPicker options={GROUPS} value={group} onChange={setGroup} ariaLabel="Group" />
      <OptionPicker options={SHOWS} value={show} onChange={setShow} ariaLabel="Show" />
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
    return shell(
      <>
        {head}
        <div className="pipeline-body">
          <div className="gear-shelf">
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
        </div>
      </>,
    );
  }

  return shell(
    <OwnershipProvider value={ownership}>
      {head}
      <div className="pipeline-body">
        <div className="gear-shelf">
          {/* The layouts are different enough that the toggle alone doesn't say
              what it just did — one line does. */}
          <p className="gear-caption">{current.hint}</p>
          {sections.length === 0 ? (
            <EmptyState
              icon={Icons.photos}
              title="No body here"
              hint="Nothing on this tab matches what Show is set to."
            />
          ) : (
            sections.map((s) =>
              s.title == null ? (
                <Layout key={s.key} view={view} kit={s.kit} />
              ) : (
                <section key={s.key} className="gear-section" aria-label={s.title}>
                  <header className="gear-section-head">
                    <h2>{s.title}</h2>
                    <span className="hint">
                      {s.kit.bodies.length} {s.kit.bodies.length === 1 ? "body" : "bodies"} ·{" "}
                      {num(s.kit.totalFrames)} media
                    </span>
                    {s.key === "unsorted" && group === "owner" && (
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        onClick={() => setDeck(s.kit.bodies)}
                      >
                        Sort them one by one
                      </button>
                    )}
                  </header>
                  <Layout view={view} kit={s.kit} />
                </section>
              ),
            )
          )}
        </div>
      </div>
      {editing && (
        <WhoseDialog
          body={editing}
          people={data.people ?? []}
          onClose={() => setEditing(null)}
          onSaved={(device, owner) => {
            applyOwner(device, owner);
            setEditing(null);
          }}
        />
      )}
      {deck && (
        <SortDeck
          queue={deck}
          people={data.people ?? []}
          onClose={() => setDeck(null)}
          onSaved={applyOwner}
        />
      )}
    </OwnershipProvider>,
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
