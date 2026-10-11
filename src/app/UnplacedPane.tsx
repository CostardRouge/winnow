"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { fetchJson } from "@/lib/fetchJson";
import {
  exemptAssets,
  geotagTargets,
  type GeotagAsset,
  type GeotagSource,
} from "@/lib/assetActions";
import { formatCaptureSpan } from "@/lib/format";
import {
  distanceM,
  isAllNoExif,
  isReady,
  parseUnplacedSort,
  sortGroups,
  tileFor,
  type UnplacedGroup,
  type UnplacedPlace,
  type UnplacedResponse,
  type UnplacedSibling,
  type UnplacedSort,
  type UnplacedStop,
  type TraceResponse,
} from "@/lib/unplacedTypes";
import ActionMenu, { type MenuItem } from "./ActionMenu";
import GeotagRecapModal, { type RecapFolder, type RecapPlace } from "./GeotagRecapModal";
import StopsDialog, { type DialogStop, type FramePoint } from "./StopsDialog";
import TraceSourcesModal from "./TraceSourcesModal";
import ReviewReady from "./ReviewReady";
import type { PickedLocation } from "./LocationPicker";
import { OptionPicker, type PickerOption } from "./OptionPicker";
import ThumbStrip, { type StripItem } from "./ThumbStrip";
import { TILE_ATTRIBUTION, TILE_URL } from "./mapTiles";
import { EmptyState, Icons, SkeletonCards } from "./ui";

// The Incoming view for the geotagging backlog (docs/UNPLACED.md): one card per
// FOLDER — the folder its title opens and its count describes — with the
// count still to place, a suggested position drawn from the located frames shot
// in the same hours (the phone in the pocket while the Sony shoots), and one
// primary verb, Place. Every apply goes through the existing recap
// (GeotagRecapModal) — this view contributes a pre-filled pin and a sentence
// saying where it came from, never a fourth write path.
//
// ONE dialog, not two: the recap carries the map itself (the shared
// LocationPicker), so Place opens straight onto the suggestion, pin dropped,
// and the map is both the check and the correction — a coordinate says
// nothing, a coastline says Pérols, and dragging the pin there is what turns
// an accepted suggestion into a verified position (§9.7).
//
// The page is a work queue, and reads like one: a progress bar over the whole
// Incoming library at the top; a triage picker — Ready (a suggestion confident
// enough to pre-fill the map, so one glance and one click), By hand (a weak or
// missing suggestion, or a container folder), All — and a sort, in the URL:
// biggest folders first by default (the maintainer's way in: the big folders
// are the ones worth the attention, §10), the parts of a folder kept
// together; Ready first (high, then medium, then the rest) for a quick pass
// over the one-click wins; or by date. And on
// every suggestion a one-tile map preview centred on the point, because the
// fastest check on "Pérols, France" is seeing the coast, and the fastest check
// on a wrong suggestion is seeing the outback (§9 — the first real run offered
// one). That preview is a button onto the same dialog: "let me look at that
// place properly" and "place them here" are one gesture. The rules that
// produce the suggestions are printed, folded behind a disclosure so a phone
// gets the bar and the cards first.
//
// Three kinds of card, one markup (the session card's own — .session-card /
// .card-head / .meta-line / .card-actions / ThumbStrip; a folder IS a
// session, and a second card family for the same object would be drift):
//   - a SHOOT: one short folder — Place N. The folders shot within gap_h of it
//     (the other body's card, on a two-body day) are NOT merged in: they are
//     named on the card ("1 folder shot alongside") and offered in the dialog
//     as unticked rows, so the day stays one gesture and nothing joins the
//     write unseen. Merging them made the card's number describe folders its
//     title did not open (§9.8);
//   - a PART of a container folder (a month, a year), cut at the same two-hour
//     silence that separates two shoots — "april 2026 · part 3 of 11", its
//     own window and suggestion, Place N applies inside the window;
//   - and on any of the first two, STOPS: when the located frames shot with
//     the card move (a day out through two towns), the card stays ONE card —
//     the folder is one thing you opened — and lists its stops, each with
//     its own window and suggestion; its Place opens the stops dialog
//     (StopsDialog), one pin per stop, where the frames of a stop unfold
//     into a contact sheet and can be moved to the next stop (§11). It offers
//     no folder alongside: the other body's folder spans both towns too;
//   - a SPAN: what a container keeps once its parts are cut out (media with no
//     camera EXIF, or no capture time), or a container too scattered to cut —
//     no pin to accept, so its primary verb sends you to the grid, where each
//     day's neighbours are visible.
// And one rule above the kinds: a card whose every unplaced media has no camera
// EXIF is screenshots and scans, and its primary verb is Exempt, not Place —
// the card says what it is instead of offering the wrong gesture.
//
// Three ways to go faster sit beside the cards (§11): "Review N ready" walks
// the confident cards from the keyboard (ReviewReady); a card nothing
// suggests names the nearest position already applied by a human, and opens
// on it; "Follow a track…" (the ⋯ menu) places each frame where an imported
// GPS track or the located frames put the photographer at its minute
// (TraceSourcesModal, then the stops dialog). None of them leaves the page:
// leaving lost the list's scroll and the dialog in progress.
//
// What is recorded depends on what the human did with the pin: accepted as
// offered (within `move_m` of the suggestion) → 'inferred', shown as such in
// the recap and never written into the originals; moved further, or placed
// with no suggestion at all → 'manual'. The recap re-reads that distance on
// every change, so the word under the map flips from "suggested" to
// "verified" as the pin leaves the suggestion — the consequence is visible
// before the button is pressed, not explained after it.

type Triage = "all" | "ready" | "hand";

// The in-flight Place flow: the group, the media the recap will list (every
// live, non-exempt media the card covers — placed ones start unchecked there,
// as always), the suggestion the card offered (`seed`, kept to measure how far
// the pin has moved from it) and the point currently chosen in the dialog
// (`loc`, undefined until one is — a card with no suggestion opens on an empty
// map and Apply waits).
// The stops dialog in flight: what StopsDialog is opened with.
type StopsFlow = {
  mode: "place" | "trace";
  group: UnplacedGroup;
  assets: GeotagAsset[];
  stops: DialogStop[];
  assign: Map<number, string>;
  points?: Map<number, FramePoint>;
  line?: { lat: number; lon: number }[];
  places?: RecapPlace[];
  subtitle: string;
};

type Flow = {
  group: UnplacedGroup;
  assets: GeotagAsset[];
  /** The card's folder, then the folders shot alongside it — the recap's
   *  per-folder rows (the card's own ticked, the others not). */
  folders: RecapFolder[];
  seed: { lat: number; lon: number } | null;
  loc?: PickedLocation;
  /** Positions already applied near the card's dates, offered as chips. */
  places: RecapPlace[];
  /** Offered points that are themselves guesses — accepted suggestions, not
   *  hand-placed pins. Taking one as offered records 'inferred', like the
   *  card's own suggestion: borrowing a guess must not make it a fact. */
  unverified: { lat: number; lon: number }[];
};

// One verb: what the button says, what its tooltip explains, what it does.
type Verb = { label: string; title: string; run: () => void };

// One tile of the shared map source, cropped to a square and shifted so the
// point sits under the pin — a map preview with no map library, one lazy
// <img> per card. z=9 shows ~80 km across a tile at these latitudes: enough
// to tell a coast from a city from an empty continent, which is the check.
const THUMB_ZOOM = 9;
const THUMB_PX = 72;
const TILE_PX = 256;

const fmt = (n: number) => n.toLocaleString("en-GB");
const pct = (share: number) => `${Math.round(share * 100)} %`;
const dayFmt = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});
const timeFmt = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
});

// A part's window is hours, not days, so it prints the times: "3 Apr 2026 ·
// 14:02–16:40". One that crosses midnight falls back to the day span.
function formatWindow(g: UnplacedGroup): string {
  if (g.kind !== "part") return formatCaptureSpan(g.t0, g.t1);
  const a = new Date(g.t0);
  const b = new Date(g.t1);
  if (a.toDateString() !== b.toDateString()) return formatCaptureSpan(g.t0, g.t1);
  const from = timeFmt.format(a);
  const to = timeFmt.format(b);
  return `${dayFmt.format(a)} · ${from === to ? from : `${from}–${to}`}`;
}

// YYYY-MM-DD in the browser's zone — the grid's date_from/date_to speak in
// calendar days.
function isoDay(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function tileSrc(lat: number, lon: number): { src: string; fx: number; fy: number } {
  const t = tileFor(lat, lon, THUMB_ZOOM);
  const src = TILE_URL.replace("{s}", "a")
    .replace("{r}", "")
    .replace("{z}", String(t.z))
    .replace("{x}", String(t.x))
    .replace("{y}", String(t.y));
  return { src, fx: t.fx, fy: t.fy };
}

// The preview is the card's second door to the same dialog: the gesture
// "let me look at that place properly" and the gesture "place these here" are
// the same one now that the dialog opens on a real map, so the thumb runs the
// card's own verb rather than growing a lightbox of its own.
function MapThumb({
  lat,
  lon,
  label,
  onOpen,
  disabled,
}: {
  lat: number;
  lon: number;
  label: string;
  onOpen: () => void;
  disabled: boolean;
}) {
  const { src, fx, fy } = tileSrc(lat, lon);
  return (
    <button
      type="button"
      className="unplaced-map"
      onClick={onOpen}
      disabled={disabled}
      title={`${label} — open the map to confirm or move the pin`}
      aria-label={`Open the map on ${label}`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        width={TILE_PX}
        height={TILE_PX}
        style={{
          left: THUMB_PX / 2 - fx * TILE_PX,
          top: THUMB_PX / 2 - fy * TILE_PX,
        }}
      />
      <span className="unplaced-map-pin" />
      <span className="unplaced-map-zoom" aria-hidden>
        ⤢
      </span>
    </button>
  );
}

function groupTitle(g: UnplacedGroup): string {
  return g.sessions[0].name;
}

// "part 3 of 11" — what slice of its container folder a card is.
function sliceLabel(g: UnplacedGroup): string | null {
  return g.part ? `part ${g.part.index} of ${g.part.count}` : null;
}

// A stop's suggestion, in the card's own words.
function stopNote(st: UnplacedStop): string {
  const s = st.suggestion;
  const who = s.donor_model ? `, mostly ${s.donor_model}` : "";
  return `From ${fmt(s.located)} located ${s.located === 1 ? "frame" : "frames"} shot then — ${pct(s.share)} in one cell${who}.`;
}

// "10:00–12:05" — a stop's first and last frame on its card (the dialog
// prints the same; the cut between two stops sits in the pause between).
function stopWindow(st: UnplacedStop): string {
  const t0 = st.first ?? st.t0;
  const t1 = st.last ?? st.t1;
  const a = new Date(t0);
  const b = new Date(t1);
  if (a.toDateString() !== b.toDateString()) return formatCaptureSpan(t0, t1);
  const from = timeFmt.format(a);
  const to = timeFmt.format(b);
  return from === to ? from : `${from}–${to}`;
}

// "same hours", "5 h before", "3 days after" — how far from the card a spot
// already placed lies.
function gapLabel(h: number): string {
  if (h === 0) return "same hours";
  const side = h < 0 ? "before" : "after";
  const a = Math.abs(h);
  if (a < 24) return `${Math.max(1, Math.round(a))} h ${side}`;
  const d = Math.round(a / 24);
  return `${d} ${d === 1 ? "day" : "days"} ${side}`;
}

function placeChip(p: UnplacedPlace): RecapPlace {
  const label = p.name ?? `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`;
  return {
    lat: p.lat,
    lon: p.lon,
    label,
    detail: `${gapLabel(p.gap_h)} · ${fmt(p.count)}`,
    title: `${fmt(p.count)} media placed here, ${gapLabel(p.gap_h)} this card${p.verified ? " — some placed by hand" : " — accepted suggestions"}`,
    verified: p.verified,
  };
}

const SORTS: PickerOption<UnplacedSort>[] = [
  {
    key: "size",
    label: "Biggest",
    hint: "The folders with the most media left to place first — a folder’s parts stay together",
  },
  {
    key: "ready",
    label: "Ready first",
    hint: "Confident suggestions first (high, medium), then low, no donor, containers — biggest first within each",
  },
  { key: "newest", label: "Newest", hint: "The most recent shoots first" },
  { key: "oldest", label: "Oldest", hint: "The oldest shoots first" },
];

function groupDevices(g: UnplacedGroup): string {
  const set = new Set(g.sessions.map((s) => s.device_hint).filter(Boolean));
  return set.size ? [...set].join(" + ") : "unknown device";
}

function groupDays(g: UnplacedGroup): number {
  return Math.max(1, Math.round((Date.parse(g.t1) - Date.parse(g.t0)) / 86_400_000));
}

// A folder shot alongside the card, as a row of the Place dialog.
function siblingFolder(x: UnplacedSibling): RecapFolder {
  return {
    id: x.id,
    name: x.name,
    detail: `${x.device_hint ?? "unknown device"} · ${formatCaptureSpan(x.captured_at_min, x.captured_at_max)}`,
    primary: false,
  };
}

function stripItems(g: UnplacedGroup): StripItem[] {
  return g.sample.map((a) => ({
    key: a.id,
    thumbSrc: `/api/assets/${a.id}/thumb`,
    ext: a.ext,
    isVideo: a.media_type === "video",
  }));
}

// One line saying what the suggestion is and where it came from, in words —
// the same sentence the recap repeats so the person confirming it never has to
// remember it from the card.
function suggestionNote(g: UnplacedGroup): string | null {
  const s = g.suggestion;
  if (!s) return null;
  const when = s.window === "near" ? "in the same hours" : "within a day";
  const who = s.donor_model ? `, mostly ${s.donor_model}` : "";
  return `From ${fmt(s.located)} located ${s.located === 1 ? "frame" : "frames"} shot ${when} — ${pct(s.share)} of them in one cell${who}.`;
}

function suggestionLabel(g: UnplacedGroup): string {
  const s = g.suggestion;
  if (!s) return "";
  return s.name ?? `${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}`;
}

export default function UnplacedPane() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  // The sort lives in the URL, like the Devices tab's: a reload or the back
  // button keeps the order the queue is being worked in.
  const sort = parseUnplacedSort(sp?.get("sort"));
  const setSort = (next: UnplacedSort) => {
    const q = new URLSearchParams(sp?.toString() ?? "");
    if (next === "size") q.delete("sort");
    else q.set("sort", next);
    const qs = q.toString();
    router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
  };
  const [data, setData] = useState<UnplacedResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [flow, setFlow] = useState<Flow | null>(null);
  // The stops dialog (a folder whose frames moved, or a followed track), the
  // card whose track sources are being chosen, and the keyboard review.
  const [stopsFlow, setStopsFlow] = useState<StopsFlow | null>(null);
  const [traceFor, setTraceFor] = useState<UnplacedGroup | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [triage, setTriage] = useState<Triage>("all");

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await fetchJson<UnplacedResponse>("/api/assets/unplaced"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Auto-dismiss the notice, like the sessions list.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  const shown = useMemo(() => {
    const all = sortGroups(data?.groups ?? [], sort);
    if (triage === "ready") return all.filter(isReady);
    if (triage === "hand") return all.filter((g) => !isReady(g));
    return all;
  }, [data, triage, sort]);

  // Every live media the card covers, in one request: the folders' for a
  // shoot or a span, the folder's inside the card's window for a part. The
  // endpoint drops the exempted ones itself — they left the backlog for good
  // and must not come back through a bulk apply.
  const loadGroupAssets = useCallback(
    (g: UnplacedGroup): Promise<GeotagAsset[]> =>
      g.kind === "part"
        ? geotagTargets([g.sessions[0].id], { from: g.t0, to: g.t1 })
        : geotagTargets(g.sessions.map((s) => s.id)),
    [],
  );

  // Place: ONE dialog. The recap carries the map now, so a card with a
  // suggestion opens on it (pin dropped, ready to confirm) and a card without
  // one opens on an empty map — the same dialog either way, and moving the pin
  // in it is what turns an accepted suggestion into a verified position.
  const openPlace = useCallback(
    async (g: UnplacedGroup, at?: PickedLocation & { verified: boolean }) => {
      if (busyKey) return;
      setBusyKey(g.key);
      try {
        // The card's own media, and — in the same round trip — every media
        // of the folders shot alongside it, which the dialog offers unticked.
        // Two requests only because a part's media are a window into its
        // folder while a sibling is always the whole folder.
        // The places already used around these dates ride along; they are a
        // convenience, so their failure never blocks the dialog.
        const [own, alongside, near] = await Promise.all([
          loadGroupAssets(g),
          g.siblings.length
            ? geotagTargets(g.siblings.map((x) => x.id))
            : Promise.resolve([] as GeotagAsset[]),
          fetchJson<{ places: UnplacedPlace[] }>(
            `/api/assets/unplaced/places?${new URLSearchParams({
              from: new Date(g.t0).toISOString(),
              to: new Date(g.t1).toISOString(),
            })}`,
          )
            .then((r) => r.places)
            .catch(() => [] as UnplacedPlace[]),
        ]);
        if (!own.length) {
          setNotice("Nothing left to place here.");
          return;
        }
        // A span's suggestion is never offered as a pin (a month of located
        // frames points at a month of places), so it opens blank. A card
        // opened on its nearest placement starts there: taken as offered it
        // records what that placement was — 'manual' when it was placed by
        // hand, 'inferred' when it was itself an accepted suggestion.
        const s = g.kind === "span" || at ? null : g.suggestion;
        setFlow({
          group: g,
          assets: [...own, ...alongside],
          folders: [
            {
              id: g.sessions[0].id,
              name: sliceLabel(g)
                ? `${groupTitle(g)} · ${sliceLabel(g)}`
                : groupTitle(g),
              detail: `${g.sessions[0].device_hint ?? "unknown device"} · ${formatWindow(g)}`,
              primary: true,
            },
            ...g.siblings.map(siblingFolder),
          ],
          seed: s ? { lat: s.lat, lon: s.lon } : null,
          loc: at ? { lat: at.lat, lon: at.lon, label: at.label } : s ? { lat: s.lat, lon: s.lon, label: s.name } : undefined,
          places: near.map(placeChip),
          unverified: [
            ...near.filter((p) => !p.verified).map((p) => ({ lat: p.lat, lon: p.lon })),
            ...(at && !at.verified ? [{ lat: at.lat, lon: at.lon }] : []),
          ],
        });
      } catch (e) {
        setNotice((e as Error).message);
      } finally {
        setBusyKey(null);
      }
    },
    [busyKey, loadGroupAssets],
  );

  // The places already used around a window, for the dialogs' chips. A
  // convenience: a failure only means no chips.
  const nearPlaces = useCallback(
    (t0: string, t1: string) =>
      fetchJson<{ places: UnplacedPlace[] }>(
        `/api/assets/unplaced/places?${new URLSearchParams({
          from: new Date(t0).toISOString(),
          to: new Date(t1).toISOString(),
        })}`,
      )
        .then((r) => r.places.map(placeChip))
        .catch(() => [] as RecapPlace[]),
    [],
  );

  // A card whose frames moved: the stops dialog, one pin per stop, each
  // seeded with its suggestion. Frames are sorted into stops by their
  // capture instant; the stop windows tile the card, so a frame with no
  // capture time is the only one that starts unplaced.
  const openStops = useCallback(
    async (g: UnplacedGroup) => {
      if (busyKey || !g.stops) return;
      setBusyKey(g.key);
      try {
        const [assets, places] = await Promise.all([loadGroupAssets(g), nearPlaces(g.t0, g.t1)]);
        const stops: DialogStop[] = g.stops.map((st) => ({
          key: `s${st.index}`,
          name: st.suggestion.name,
          pin: { lat: st.suggestion.lat, lon: st.suggestion.lon, label: st.suggestion.name },
          seed: { lat: st.suggestion.lat, lon: st.suggestion.lon },
          note: stopNote(st),
          confidence: st.suggestion.confidence,
        }));
        const assign = new Map<number, string>();
        for (const a of assets) {
          if (a.gps || !a.captured_at) continue;
          const t = Date.parse(a.captured_at);
          const st = g.stops.find((x) => t >= Date.parse(x.t0) && t <= Date.parse(x.t1));
          if (st) assign.set(a.id, `s${st.index}`);
        }
        setStopsFlow({
          mode: "place",
          group: g,
          assets,
          stops,
          assign,
          places,
          subtitle: `${fmt(g.unplaced)} frames · ${g.stops.length} stops, from the located frames shot with them`,
        });
      } catch (e) {
        setNotice((e as Error).message);
      } finally {
        setBusyKey(null);
      }
    },
    [busyKey, loadGroupAssets, nearPlaces],
  );

  // A followed track came back: the same dialog, its stops read-only, each
  // frame at its own point.
  const openTrace = useCallback(
    async (g: UnplacedGroup, trace: TraceResponse) => {
      setTraceFor(null);
      if (!trace.frames.length) {
        setNotice("Nothing left to place here.");
        return;
      }
      if (!trace.stops.length) {
        setNotice(`The track has no point near any of these ${fmt(trace.frames.length)} frames.`);
        return;
      }
      try {
        const assets = await loadGroupAssets(g);
        const points = new Map<number, FramePoint>();
        for (const f of trace.frames) {
          if (f.pos && f.source) points.set(f.id, { ...f.pos, source: f.source, import_id: f.import_id });
        }
        const assign = new Map<number, string>();
        for (const st of trace.stops) for (const id of st.ids) assign.set(id, `t${st.index}`);
        const fromTrack = (ids: number[]) => ids.filter((id) => points.get(id)?.source === "track").length;
        const stops: DialogStop[] = trace.stops.map((st) => {
          const tracked = fromTrack(st.ids);
          return {
            key: `t${st.index}`,
            name: st.name,
            pin: { lat: st.lat, lon: st.lon, label: st.name },
            seed: null,
            moving: st.moving,
            note:
              tracked === st.ids.length
                ? "Every frame from an imported track."
                : tracked
                  ? `${fmt(tracked)} from an imported track, ${fmt(st.ids.length - tracked)} from your located frames.`
                  : "From your located frames shot in the same minutes.",
          };
        });
        const known = new Set(trace.frames.map((f) => f.id));
        setStopsFlow({
          mode: "trace",
          group: g,
          assets: assets.filter((a) => known.has(a.id)),
          stops,
          assign,
          points,
          line: trace.line,
          subtitle: `${fmt(trace.frames.length)} frames · ${trace.stops.length} ${trace.stops.length === 1 ? "stop" : "stops"}${trace.gaps.length ? ` · ${fmt(trace.gaps.length)} in a gap of the track` : ""}`,
        });
      } catch (e) {
        setNotice((e as Error).message);
      }
    },
    [loadGroupAssets],
  );

  // Exempt the card's media that carry no camera EXIF at all — the census's
  // discriminator for screenshots and scans — one card at a time, never the
  // whole library, and never silently.
  const exemptNoExif = useCallback(
    async (g: UnplacedGroup) => {
      if (busyKey) return;
      setBusyKey(g.key);
      try {
        const assets = await loadGroupAssets(g);
        const ids = assets
          .filter((a) => !a.gps && !a.camera_model && !a.lens)
          .map((a) => a.id);
        if (!ids.length) {
          setNotice("No media without camera EXIF left here.");
          return;
        }
        const n = await exemptAssets(ids, true);
        setNotice(`${fmt(n)} media marked as never needing a position`);
        await load();
      } catch (e) {
        setNotice((e as Error).message);
      } finally {
        setBusyKey(null);
      }
    },
    [busyKey, loadGroupAssets, load],
  );

  // The grid, on the card's first folder and its unplaced media; a part also
  // narrows it to its day(s).
  const openGrid = useCallback(
    (g: UnplacedGroup) => {
      const sp = new URLSearchParams({
        session_id: String(g.sessions[0].id),
        geo_state: "todo",
      });
      if (g.kind === "part") {
        // A day of slack each side: the grid filters on the stored capture
        // day (the place's local day, else UTC) and this is the browser's,
        // so a part starting at 23:30 UTC opened on the next day and its
        // first frames were missing from a grid the card counted them in.
        const DAY = 86_400_000;
        sp.set("date_from", isoDay(new Date(new Date(g.t0).getTime() - DAY)));
        sp.set("date_to", isoDay(new Date(new Date(g.t1).getTime() + DAY)));
      }
      router.push(`/library/incoming/grid?${sp}`);
    },
    [router],
  );

  // The grid on one folder over a window of it, as a URL — the stops
  // dialog's secondary link, opened in a new tab so the dialog survives it.
  const gridHref = (sessionId: number) => (from: number, to: number) => {
    const DAY = 86_400_000;
    const sp = new URLSearchParams({
      session_id: String(sessionId),
      geo_state: "todo",
      date_from: isoDay(new Date(from - DAY)),
      date_to: isoDay(new Date(to + DAY)),
    });
    return `/library/incoming/grid?${sp}`;
  };

  // What the recap will record, decided by what the human did with the pin.
  const flowSource = (f: Flow): GeotagSource => {
    if (!f.loc) return "manual";
    const m = data?.rules.move_m ?? 100;
    const offered = [...(f.seed ? [f.seed] : []), ...f.unverified];
    return offered.some((o) => distanceM(o, f.loc!) <= m) ? "inferred" : "manual";
  };

  const rules = data?.rules;
  const totals = data?.totals;
  // The cards the keyboard review walks, in the order on screen.
  const readyList = useMemo(() => sortGroups(data?.groups ?? [], sort).filter(isReady), [data, sort]);
  const anyMap = shown.some((g) => g.kind !== "span" && g.suggestion);

  // One primary verb per card (UI review), the rest behind the ⋯. Which verb
  // is primary is decided by what the card is, not by what is possible: a
  // screenshot pile exempts, a span opens in the grid, everything else places.
  function cardVerbs(g: UnplacedGroup): { primary: Verb; items: MenuItem[] } {
    const busy = busyKey != null;
    const n = fmt(g.unplaced);
    const place: Verb = {
      label: `Place ${n}`,
      title: isReady(g)
        ? "Confirm the suggested position on the map, then apply per media"
        : "Pick a position on the map, then apply per media",
      run: () => void openPlace(g),
    };
    const grid: Verb = {
      label: `Open ${n} in grid`,
      title: "The unplaced media in the grid, day by day",
      run: () => openGrid(g),
    };
    const exempt: Verb = {
      label: `Exempt ${fmt(g.no_exif)} without camera EXIF`,
      title: "Screenshots, scans — never need a position",
      run: () => void exemptNoExif(g),
    };
    const item = (key: string, v: Verb, icon: string): MenuItem => ({
      key,
      label: v.label,
      hint: v.title,
      icon,
      disabled: busy,
      onSelect: v.run,
    });

    if (isAllNoExif(g)) {
      return {
        primary: exempt,
        items: [
          item("place", { ...place, label: `Place ${n} anyway…` }, "📌"),
          item("grid", { ...grid, label: "Open in grid" }, "▦"),
        ],
      };
    }
    if (g.kind === "span") {
      const items = [
        item(
          "place",
          {
            ...place,
            label: `Place all ${n} at one point…`,
            title: "Only if the whole folder really is one place",
          },
          "📌",
        ),
      ];
      // Only on a container too scattered to cut: its frames are on no other
      // card. What a CUT container leaves on its span (no camera EXIF, no
      // capture time) is nothing a track can place.
      if (g.moments != null) {
        items.push(
          item(
            "trace",
            {
              label: "Follow a track…",
              title: "Place each frame where a GPS track or your phone was at its minute",
              run: () => setTraceFor(g),
            },
            "〰",
          ),
        );
      }
      if (g.no_exif > 0) items.push(item("exempt", exempt, "⊘"));
      return { primary: grid, items };
    }
    const trace = item(
      "trace",
      {
        label: "Follow a track…",
        title: "Place each frame where a GPS track or your phone was at its minute",
        run: () => setTraceFor(g),
      },
      "〰",
    );
    const items: MenuItem[] = [trace];
    if (g.no_exif > 0) items.push(item("exempt", exempt, "⊘"));
    items.push(item("grid", { ...grid, label: "Open in grid" }, "▦"));
    if (g.stops) {
      return {
        primary: {
          label: `Place ${n} · ${g.stops.length} stops`,
          title: "One pin per stop, the frames of each stop to check",
          run: () => void openStops(g),
        },
        items: [item("place", { ...place, label: `Place all ${n} at one point…`, title: "Only if the stops really are one place" }, "📌"), ...items],
      };
    }
    if (!g.suggestion && g.nearest) {
      const at = g.nearest;
      return {
        primary: {
          label: `Place ${n} there…`,
          title: `Open on ${at.name ?? "the nearest placement"} — confirm or move it`,
          run: () =>
            void openPlace(g, { lat: at.lat, lon: at.lon, label: at.name, verified: at.verified }),
        },
        items: [item("place", { ...place, label: "Pick a different place…" }, "📌"), ...items],
      };
    }
    return { primary: place, items };
  }

  // A thumbnail opens the card's dialog when its verb IS a dialog (Place,
  // the stops); a screenshot pile's verb writes (Exempt) and a span's leaves
  // (the grid), so there a thumbnail keeps opening the session page — a click
  // to look must never write.
  const thumbOpen = (g: UnplacedGroup, primary: Verb) =>
    isAllNoExif(g) || g.kind === "span" ? () => router.push(`/sessions/${g.sessions[0].id}`) : primary.run;

  // The line under the meta: the suggestion and its provenance, or why there
  // is none and what to do instead.
  function suggestLine(g: UnplacedGroup) {
    if (isAllNoExif(g)) {
      return (
        <div className="card-suggest is-none">
          Nothing here carries camera EXIF — screenshots or scans. Exempt them
          and this card is done.
        </div>
      );
    }
    if (g.kind === "span") {
      return (
        <div className="card-suggest is-none">
          {g.moments != null
            ? `Its unplaced camera media fall into ${fmt(g.moments)} separate moments over ${fmt(groupDays(g))} days — more than the ${rules?.parts_max ?? 40} parts a card list carries. Work it from the grid, where each day’s neighbours are visible.`
            : `What lies outside this folder’s parts: media with no camera EXIF or no capture time. Place them from the grid.`}
        </div>
      );
    }
    if (g.stops) {
      return (
        <div className="card-suggest is-none">
          The located frames shot with these moved more than {rules?.split_km ?? 5} km:
          one place per stop, cut in the camera’s pause between two.
        </div>
      );
    }
    const s = g.suggestion;
    if (!s && g.nearest) {
      const at = g.nearest;
      return (
        <div className="card-suggest">
          Nearest placement: <strong>{at.name ?? `${at.lat.toFixed(4)}, ${at.lon.toFixed(4)}`}</strong>
          <span className="hint">
            {" "}— folder “{at.folder}” · {gapLabel(at.gap_h)} · {at.verified ? "placed by hand" : "a suggestion you accepted"}.
            No located frame within a day of these.
          </span>
        </div>
      );
    }
    if (!s) {
      return (
        <div className="card-suggest is-none">
          No located frame within a day of these, and nothing placed within {rules?.reuse_d ?? 30} days.
          A track might know: <button type="button" className="link-btn" onClick={() => setTraceFor(g)}>Follow a track…</button>
        </div>
      );
    }
    return (
      <div className="card-suggest">
        Suggested: <strong>{suggestionLabel(g)}</strong>
        <span className={`conf is-${s.confidence}`}>{s.confidence}</span>
        <span className="hint"> — {suggestionNote(g)}</span>
      </div>
    );
  }

  const triageOptions: PickerOption<Triage>[] = [
    { key: "all", label: "All", count: totals?.groups },
    {
      key: "ready",
      label: "Ready",
      hint: "A suggestion confident enough to pre-fill the map — glance, confirm",
      count: totals?.ready,
    },
    {
      key: "hand",
      label: "By hand",
      hint: "A weak or missing suggestion, or a container folder",
      count: totals?.by_hand,
    },
  ];

  const barTotal = totals ? totals.placed + totals.unplaced + totals.exempt : 0;
  const barW = (n: number) => (barTotal ? `${(n / barTotal) * 100}%` : "0%");

  return (
    <div className="sessions-pane">
      {notice && (
        <div style={{ marginBottom: 12 }}>
          <span className="notice">{notice}</span>
        </div>
      )}
      {error && (
        <div className="error-box">
          <span>Couldn’t load the backlog: {error}</span>
          <button className="btn" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}

      {loading ? (
        <SkeletonCards rows={5} />
      ) : !data || !totals || (data.groups.length === 0 && totals.unplaced === 0) ? (
        <EmptyState
          icon={Icons.inbox}
          title="Everything is placed"
          hint="Every Incoming media has a position or was marked as never needing one."
        />
      ) : (
        <>
          <div className="unplaced-head">
            <div
              className="unplaced-bar"
              role="img"
              aria-label={`${fmt(totals.placed)} placed, ${fmt(totals.unplaced)} to place, ${fmt(totals.exempt)} exempt`}
            >
              <span className="is-placed" style={{ width: barW(totals.placed) }} />
              <span className="is-todo" style={{ width: barW(totals.unplaced) }} />
              <span className="is-exempt" style={{ width: barW(totals.exempt) }} />
            </div>
            <div className="unplaced-legend">
              <span>
                <strong>{fmt(totals.unplaced)}</strong> to place
              </span>
              <span className="meta-sep">·</span>
              <span>{fmt(totals.placed)} placed</span>
              {totals.exempt > 0 && (
                <>
                  <span className="meta-sep">·</span>
                  <span>{fmt(totals.exempt)} exempt</span>
                </>
              )}
              <span className="meta-sep">·</span>
              <span>
                {fmt(totals.groups)} {totals.groups === 1 ? "card" : "cards"}
              </span>
              {totals.no_exif > 0 && (
                <>
                  <span className="meta-sep">·</span>
                  <span>{fmt(totals.no_exif)} without camera EXIF</span>
                </>
              )}
            </div>
            <div className="unplaced-tools">
              <div className="unplaced-pickers">
                <OptionPicker
                  size="sm"
                  ariaLabel="Which cards to show"
                  options={triageOptions}
                  value={triage}
                  onChange={setTriage}
                />
                <OptionPicker
                  size="sm"
                  ariaLabel="Order the cards"
                  options={SORTS}
                  value={sort}
                  onChange={setSort}
                />
                {readyList.length > 0 && (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => setReviewing(true)}
                    title="One card after another: Enter applies, → skips"
                  >
                    Review {fmt(readyList.length)} ready
                  </button>
                )}
              </div>
              {rules && (
                <details className="card-rules">
                  <summary>How the cards and their suggestions are made</summary>
                  <p className="hint">
                    Each folder is its own card. The folders shot within{" "}
                    {rules.gap_h} h of it are offered in its Place dialog,
                    unticked — tick them to place a two-body day in one go. A
                    folder spanning more than {rules.span_max_h} h is a
                    container (a month, a year): its unplaced camera media are
                    cut into parts at every {rules.gap_h} h silence, each part
                    its own card, up to {rules.parts_max} parts — past that the
                    folder stays one card that opens in the grid. Media with no
                    camera EXIF (screenshots, scans) never take part in the cut
                    and stay behind to be exempted. When the located frames
                    shot with a card move more than {rules.split_km} km (at
                    least {rules.split_min} frames in each place), the card
                    gets one stop per place, cut in the longest pause of the
                    camera between two places, each with its own pin. A
                    suggestion comes from the
                    located frames within ±{rules.near_h} h of the card’s window
                    (±{rules.day_h} h failing that), camera fixes and hand-placed
                    pins only. It pre-fills the map from {pct(rules.medium)} of
                    those frames in one cell — {pct(rules.high)} for high
                    confidence — and never under {rules.floor} frames. Accepting
                    the pin as offered records a suggested position, not written
                    into the originals; moving it more than {rules.move_m} m
                    records a verified one. The Place dialog also lists the
                    positions already applied within {rules.reuse_d} days of
                    the card — one click puts the pin there; a card nothing
                    suggests shows the nearest of them. “Follow a track…”
                    places each frame where an imported GPS track, or your
                    located frames, put you at its minute — a stretch shorter
                    than {rules.stay_min} min is passed through, and joins its
                    neighbours as one stop on the move.
                  </p>
                </details>
              )}
            </div>
          </div>

          {shown.length === 0 ? (
            <EmptyState
              icon={Icons.inbox}
              title={triage === "ready" ? "Nothing ready to confirm" : "Nothing here"}
              hint={
                triage === "ready"
                  ? "No card has a confident suggestion left — the rest is by hand."
                  : "Switch to All to see every card."
              }
            />
          ) : (
            <div className="session-list">
              {shown.map((g) => {
                const s = g.suggestion;
                const busy = busyKey === g.key;
                const first = g.sessions[0];
                const devices = groupDevices(g);
                const { primary, items } = cardVerbs(g);
                return (
                  <div
                    key={g.key}
                    className={`session-card is-stacked unplaced-card is-${g.kind}`}
                  >
                    <div className="card-head">
                      {s && g.kind !== "span" && !g.stops && (
                        <MapThumb
                          lat={s.lat}
                          lon={s.lon}
                          label={suggestionLabel(g)}
                          onOpen={() => void openPlace(g)}
                          disabled={busyKey != null}
                        />
                      )}
                      <div className="card-info">
                        <h3>
                          <Link href={`/sessions/${first.id}`}>{groupTitle(g)}</Link>
                          {sliceLabel(g) && (
                            <span className="hint">
                              {" "}
                              · {sliceLabel(g)}
                            </span>
                          )}
                          {g.stops && (
                            <span className="hint">
                              {" "}
                              · {g.stops.length} places
                            </span>
                          )}
                          {g.siblings.length > 0 && (
                            <span
                              className="hint"
                              title={`Shot within ${rules?.gap_h ?? 2} h of this one — offered, unticked, when you place it:\n${g.siblings
                                .map((x) => `${x.name} (${fmt(x.unplaced)} unplaced)`)
                                .join("\n")}`}
                            >
                              {" "}
                              · {g.siblings.length}{" "}
                              {g.siblings.length === 1 ? "folder" : "folders"} shot
                              alongside
                            </span>
                          )}
                        </h3>
                        <div className="meta">
                          <span className="meta-line">
                            <span className="meta-when">{formatWindow(g)}</span>
                            <span className="meta-sep">·</span>
                            <span className="meta-device" title={devices}>
                              {devices}
                            </span>
                            <span className="meta-sep">·</span>
                            <span className="meta-count">
                              {fmt(g.total)} {g.total === 1 ? "file" : "files"}
                            </span>
                          </span>
                          <span className="pill" title="No position yet, not exempted">
                            {fmt(g.unplaced)} unplaced
                          </span>
                          {g.no_exif > 0 && (
                            <span
                              className="pill"
                              title="Unplaced media with neither a camera model nor a lens — likely screenshots or scans"
                            >
                              {fmt(g.no_exif)} without camera EXIF
                            </span>
                          )}
                          {g.exempt > 0 && (
                            <span className="pill" title="Marked as never needing a position">
                              {fmt(g.exempt)} exempt
                            </span>
                          )}
                        </div>
                        {suggestLine(g)}
                        {g.stops && (
                          <ol className="card-stops" aria-label="Stops">
                            {g.stops.map((st) => (
                              <li key={st.index}>
                                <button
                                  type="button"
                                  className="card-stop"
                                  disabled={busyKey != null}
                                  onClick={() => void openStops(g)}
                                  title="Open the stops: one pin each, their frames to check"
                                >
                                  <span className="stop-num" aria-hidden="true">{st.index}</span>
                                  <span className="card-stop-text">
                                    <strong>{st.suggestion.name ?? `${st.suggestion.lat.toFixed(3)}, ${st.suggestion.lon.toFixed(3)}`}</strong>
                                    <span className="hint">
                                      {stopWindow(st)} · {fmt(st.unplaced)} {st.unplaced === 1 ? "frame" : "frames"}
                                    </span>
                                  </span>
                                  <span className={`conf is-${st.suggestion.confidence}`}>{st.suggestion.confidence}</span>
                                  <span className="card-stop-thumbs" aria-hidden="true">
                                    {st.sample.slice(0, 4).map((a) => (
                                      // eslint-disable-next-line @next/next/no-img-element
                                      <img key={a.id} src={`/api/assets/${a.id}/thumb`} alt="" loading="lazy" />
                                    ))}
                                  </span>
                                </button>
                              </li>
                            ))}
                          </ol>
                        )}
                      </div>
                      <div className="card-side">
                        <div className="card-actions">
                          <button
                            className="btn btn-primary card-primary"
                            disabled={busyKey != null}
                            onClick={primary.run}
                            title={primary.title}
                          >
                            {busy ? "Working…" : primary.label}
                          </button>
                          <ActionMenu
                            ariaLabel={`More actions for ${groupTitle(g)}`}
                            items={items}
                          />
                        </div>
                      </div>
                    </div>
                    {!g.stops && (
                      // A thumb opens the card's own verb — the dialog where
                      // the frames are — rather than another page: leaving
                      // the list lost its scroll and the work in progress.
                      <ThumbStrip
                        items={stripItems(g)}
                        total={g.total}
                        onItemActivate={thumbOpen(g, primary)}
                        onOverflowActivate={thumbOpen(g, primary)}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {anyMap && (
            <p
              className="hint unplaced-attrib"
              // The tile source's own attribution string (operator-configured,
              // HTML by contract — the map view renders the same one).
              dangerouslySetInnerHTML={{ __html: `Map previews ${TILE_ATTRIBUTION}` }}
            />
          )}
        </>
      )}

      {stopsFlow && (
        <StopsDialog
          mode={stopsFlow.mode}
          title={`${groupTitle(stopsFlow.group)}${sliceLabel(stopsFlow.group) ? ` · ${sliceLabel(stopsFlow.group)}` : ""}`}
          subtitle={`${formatWindow(stopsFlow.group)} · ${stopsFlow.subtitle}`}
          assets={stopsFlow.assets}
          stops={stopsFlow.stops}
          assign={stopsFlow.assign}
          points={stopsFlow.points}
          line={stopsFlow.line}
          places={stopsFlow.places}
          moveM={rules?.move_m ?? 100}
          gridHref={gridHref(stopsFlow.group.sessions[0].id)}
          onClose={() => setStopsFlow(null)}
          onApplied={(message) => {
            setStopsFlow(null);
            setNotice(message);
            void load();
          }}
        />
      )}

      {traceFor && (
        <TraceSourcesModal
          sessionId={traceFor.sessions[0].id}
          from={traceFor.t0}
          to={traceFor.t1}
          label={formatWindow(traceFor)}
          onClose={() => setTraceFor(null)}
          onReady={(trace) => void openTrace(traceFor, trace)}
        />
      )}

      {reviewing && (
        <ReviewReady
          groups={readyList}
          moveM={rules?.move_m ?? 100}
          describe={(g) => ({ when: formatWindow(g), note: suggestionNote(g) })}
          onOpenRecap={(g) => {
            setReviewing(false);
            void load();
            void openPlace(g);
          }}
          onClose={(changed) => {
            setReviewing(false);
            if (changed) void load();
          }}
        />
      )}

      {flow && (
        <GeotagRecapModal
          assets={flow.assets}
          target={flow.loc ?? null}
          source={flowSource(flow)}
          sourceNote={
            flowSource(flow) !== "inferred"
              ? null
              : flow.seed && flow.loc && distanceM(flow.seed, flow.loc) <= (rules?.move_m ?? 100)
                ? suggestionNote(flow.group)
                : "A position accepted as a suggestion for another folder — borrowed as offered, it stays a suggestion. Move the pin to verify it."
          }
          onTargetChange={(loc) => setFlow({ ...flow, loc })}
          folders={flow.folders}
          places={flow.places}
          onClose={() => setFlow(null)}
          onApplied={(message) => {
            setFlow(null);
            setNotice(message);
            void load();
          }}
        />
      )}
    </div>
  );
}
