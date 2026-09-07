// The kit, prepared once for whichever layout is on screen.
//
// /gear draws the same inventory four different ways (cf. GearPanel), and every
// one of them needs the same derivations: which half of the library is active,
// where a card links, how a tally spells itself, what a lens' optics are, how
// busy a piece of gear is relative to the rest. Doing that inside each view
// would be four chances for the numbers to disagree — so the views receive a
// finished `Kit` and only decide how to draw it.
//
// Everything here is pure: no fetch, no state, no JSX.
import {
  cameraKind,
  CAMERA_KINDS,
  lensOptics,
  lensSpecLabel,
  type CameraKind,
  type LensOptics,
} from "@/lib/gearSpec";
import type { GearCamera, GearLens, GearStats } from "@/lib/gearTypes";
import {
  effectiveLibrarySource,
  type LibrarySource,
} from "@/app/LibrarySourceTabs";

export type Sort = "used" | "recent";

export const SORTS: { key: Sort; label: string; title: string }[] = [
  { key: "used", label: "Most used", title: "Busiest gear first" },
  { key: "recent", label: "Recent", title: "Most recently used first" },
];

export const num = (n: number) => n.toLocaleString();

/** Union of a body/lens's two per-source tallies — "All". */
export function mergeStats(a: GearStats, b: GearStats): GearStats {
  const earliest = (x: string | null, y: string | null) =>
    x == null ? y : y == null ? x : x < y ? x : y;
  const latest = (x: string | null, y: string | null) =>
    x == null ? y : y == null ? x : x > y ? x : y;
  return {
    count: a.count + b.count,
    photos: a.photos + b.photos,
    videos: a.videos + b.videos,
    first_capture: earliest(a.first_capture, b.first_capture),
    last_capture: latest(a.last_capture, b.last_capture),
  };
}

/** The tally for the active source — Incoming/Gallery read directly, All summed. */
export function statsFor(
  x: { incoming: GearStats; gallery: GearStats },
  source: LibrarySource,
): GearStats {
  return source === "all" ? mergeStats(x.incoming, x.gallery) : x[source];
}

/**
 * Where a piece of gear's frames live, for the active source. `lenses` is every
 * raw EXIF spelling the entry merged (cf. lib/lensLabels.ts) — the filter is
 * multi-value, so one entry still reaches all of its frames.
 */
export function gridHref(
  base: "incoming" | "gallery",
  device: string,
  lenses?: string[],
): string {
  const sp = new URLSearchParams({ device });
  if (lenses?.length) sp.set("lens", lenses.join(","));
  // Both targets seed their filters from the query string: Incoming through its
  // `[view]` route (Grid is the one that shows the frames themselves), the
  // Gallery tab through the same decode (cf. library/gallery/page.tsx).
  const path = base === "gallery" ? "/library/gallery" : "/library/incoming/grid";
  return `${path}?${sp.toString()}`;
}

/** "2019–2026" — the years a piece of gear was in service, from its frames. */
export function years(first: string | null, last: string | null): string | null {
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

/** Photos, videos, or a mixed bag — number and unit, kept apart so a layout can
 *  stack them into an aligned figures column or blow the number up. */
export function countParts(s: GearStats): { n: string; unit: string } {
  if (s.videos === 0)
    return { n: num(s.photos), unit: s.photos === 1 ? "photo" : "photos" };
  if (s.photos === 0)
    return { n: num(s.videos), unit: s.videos === 1 ? "video" : "videos" };
  return { n: num(s.count), unit: "media" };
}

/** The same tally as one string. */
export function countLabel(s: GearStats): string {
  const { n, unit } = countParts(s);
  return `${n} ${unit}`;
}

/** Mixed libraries get the split spelled out; single-medium ones don't need it. */
export function splitLine(s: GearStats): string | null {
  if (s.photos > 0 && s.videos > 0)
    return `${num(s.photos)} photos · ${num(s.videos)} videos`;
  return null;
}

/**
 * "45,230 shutter actuations · Jul 2026" — the body's odometer, as read off the
 * newest indexed frame carrying the counter (Sony MakerNotes, cf. lib/gear.ts).
 * The date says how fresh the reading is: frames shot since but not yet
 * imported aren't counted. Null-count bodies (phones, drones) show nothing.
 */
export function shutterLine(c: GearCamera): string | null {
  if (c.shutter_count == null) return null;
  const line = `${num(c.shutter_count)} shutter actuations`;
  if (!c.shutter_count_at) return line;
  const d = new Date(c.shutter_count_at);
  if (!Number.isFinite(d.getTime())) return line;
  const asOf = d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
  return `${line} · ${asOf}`;
}

/** "…and 3 more in the Gallery" — what the other half of the library holds.
 *  Meaningless on "All" (there is no "elsewhere" once both halves are summed),
 *  so `other` is null there and the line simply doesn't render. */
export function elsewhereLine(
  other: GearStats | null,
  source: "incoming" | "gallery",
): string | null {
  if (!other || other.count === 0) return null;
  const where = source === "gallery" ? "Incoming" : "the Gallery";
  return `${num(other.count)} more in ${where}`;
}

/** Milliseconds, or null when the date is missing or unparseable. */
function ms(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

/** "Jul 2026" — how fresh the shutter reading is, on its own so a spec table can
 *  put it beside the number instead of inside a sentence. */
function asOf(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

/**
 * The ink a share of the whole is painted with: one hue, light for a sliver,
 * dark for the bulk (the Stack bars and the Blocks tiles).
 *
 * The mapping is ABSOLUTE — it reads the share itself, never the segment's rank
 * in its bar. A tone that came from "biggest, second, third" would repaint every
 * surviving segment the moment the Incoming/Gallery tab changed the set around
 * it, and a colour that moves under the same piece of glass is a colour that
 * means nothing. Square root because the interesting range is the bottom of the
 * scale: most kits are one lens doing half the work and a long tail under 10%.
 */
export function shareInk(share: number): string {
  const pct = Math.round(26 + 62 * Math.sqrt(Math.max(share, 0)));
  return `color-mix(in srgb, var(--color-text) ${pct}%, var(--color-bg))`;
}

/** Text laid ON a `shareInk` fill: the page's ground once the fill goes dark. */
export function shareInkText(share: number): string {
  return 26 + 62 * Math.sqrt(Math.max(share, 0)) > 52
    ? "var(--color-bg)"
    : "var(--color-text)";
}

// ------------------------------------------------------------------ axes ----

/** Where a millimetre ruler is allowed to put a label — the focal lengths people
 *  say out loud. Only the ones inside the kit's own range are drawn. */
const NICE_MM = [8, 10, 12, 14, 16, 20, 24, 28, 35, 50, 70, 85, 105, 135, 200, 300, 400, 600, 800];

export type FocalAxis = {
  /** A focal length in mm → its position on the track, 0–1. */
  at: (mm: number) => number;
  ticks: { mm: number; at: number }[];
};

/**
 * The focal-length scale, shared by Coverage and Marks so the two charts place
 * the same lens at the same spot.
 *
 * Logarithmic on purpose: 16→24mm is the same visual step as 200→300mm, which
 * is how focal lengths are actually experienced. A linear axis would crush a
 * whole wide-angle kit into the first centimetre of a 400mm library.
 */
export function focalAxis(focal: { min: number; max: number }): FocalAxis {
  // A hair of padding in log space, so a lens sitting on the kit's extreme
  // isn't drawn flush against the edge of its track.
  const lo = Math.log(Math.max(focal.min, 1) / 1.12);
  const hi = Math.log(Math.max(focal.max, focal.min * 1.2) * 1.12);
  const at = (mm: number) => (Math.log(Math.max(mm, 1)) - lo) / (hi - lo);
  // A short kit packs several nice values into one centimetre of ruler (12·14·16
  // on a wide-angle bag), so labels closer than a legible gap are dropped — the
  // ruler is a reference, not a complete list.
  const ticks: { mm: number; at: number }[] = [];
  for (const mm of NICE_MM) {
    const x = at(mm);
    if (x < 0 || x > 1) continue;
    if (ticks.length > 0 && x - ticks[ticks.length - 1].at < 0.05) continue;
    ticks.push({ mm, at: x });
  }
  // A kit spanning less than one nice interval (a single prime, two close zooms)
  // gets its own two bounds as the ruler rather than no ruler at all.
  if (ticks.length >= 2) return { at, ticks };
  const ends = [Math.round(focal.min), Math.round(focal.max)].filter(
    (mm, i, a) => a.indexOf(mm) === i,
  );
  return { at, ticks: ends.map((mm) => ({ mm, at: at(mm) })) };
}

// ------------------------------------------------------------------- kit ----

/** A lens as every layout wants it: tallied, linked, spec'd, weighed. */
export type KitLens = {
  key: string;
  label: string;
  names: string[];
  stats: GearStats;
  optics: LensOptics;
  /** "56mm f/1.2", plus the EXIF-merge note where there is one. */
  spec: string | null;
  href: string;
  years: string | null;
  /** Every raw spelling + the meta the compact layouts don't spell out. */
  tip: string;
  /** Share of its body's tagged frames, 0–1 — the meters and bar weights. */
  share: number;
  from: number | null;
  to: number | null;
};

/**
 * A slice of ONE body's frames: a lens, or the remainder no lens tag accounts
 * for. The composition layouts (Stack, Blocks) divide a body by these rather
 * than by `lenses`, because a bar that leaves the untagged frames out would be
 * a bar that doesn't add up to the number printed next to it.
 *
 * `share` is of the body's whole — note that `KitLens.share` is of its TAGGED
 * frames only, which is the right denominator for a meter beside a lens row and
 * the wrong one for a slice of a pie.
 */
export type KitPart = {
  key: string;
  label: string;
  count: number;
  share: number;
  /** null on the untagged remainder: there is no lens to filter the grid on. */
  href: string | null;
  tip: string;
};

/** One body and the glass that rode on it — the unit every layout is built from. */
export type KitBody = {
  name: string;
  label: string;
  kind: CameraKind;
  kindLabel: string;
  stats: GearStats;
  href: string;
  years: string | null;
  /** "45,230 shutter actuations · Jul 2026" — the odometer as one line. */
  shutter: string | null;
  /** …and the same reading split, for a spec table that has a column for each. */
  shutterCount: number | null;
  shutterAt: string | null;
  split: string | null;
  elsewhere: string | null;
  /** Frames whose files carry no lens tag — named rather than hidden, so the
   *  body's total and its lens rows add up. */
  untagged: number;
  lenses: KitLens[];
  /** The same frames cut into slices that sum to `stats.count` (cf. KitPart). */
  parts: KitPart[];
  /** Share of the busiest body's frames, 0–1. */
  share: number;
  tip: string;
  from: number | null;
  to: number | null;
};

export type Kit = {
  bodies: KitBody[];
  lensCount: number;
  totalFrames: number;
  /** Union of every body's service span, in ms — the timeline's axis. */
  span: { from: number; to: number } | null;
  /** Focal bounds in mm across every lens that recorded one — the coverage axis. */
  focal: { min: number; max: number } | null;
  /** Fastest and slowest maximum aperture recorded — the Marks vertical axis. */
  aperture: { min: number; max: number } | null;
};

/** Busiest first / most recently used first, both read off the active source. */
function sortFor(sort: Sort, source: LibrarySource) {
  return <T extends { label: string; incoming: GearStats; gallery: GearStats }>(
    a: T,
    b: T,
  ) => {
    const sa = statsFor(a, source);
    const sb = statsFor(b, source);
    return sort === "recent"
      ? (sb.last_capture ?? "").localeCompare(sa.last_capture ?? "") ||
          a.label.localeCompare(b.label)
      : sb.count - sa.count || a.label.localeCompare(b.label);
  };
}

function buildLens(
  lens: GearLens,
  device: string,
  source: LibrarySource,
  tagged: number,
): KitLens {
  const stats = statsFor(lens, source);
  const base = effectiveLibrarySource(source, lens.incoming.count);
  const other = source === "all" ? null : lens[source === "incoming" ? "gallery" : "incoming"];
  // The optics are derived, so a lens whose name states nothing ("E 18-55")
  // still shows the range its frames recorded.
  const optics = lensOptics(lens.label, {
    focalMin: lens.focal_min,
    focalMax: lens.focal_max,
    aperture: lens.aperture_min,
  });
  const spec = [
    lensSpecLabel(optics) || null,
    lens.names.length > 1 ? `${lens.names.length} EXIF names` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  // The tooltip carries every raw EXIF spelling this entry merged — a merge is
  // always inspectable rather than something that just happened — plus the
  // meta the compact layouts no longer spell out.
  const tip = [
    lens.names.join(" · "),
    splitLine(stats),
    elsewhereLine(other, source === "gallery" ? "gallery" : "incoming"),
  ]
    .filter(Boolean)
    .join("\n");
  return {
    key: lens.key,
    label: lens.label,
    names: lens.names,
    stats,
    optics,
    spec: spec || null,
    href: gridHref(base, device, lens.names),
    years: years(stats.first_capture, stats.last_capture),
    tip,
    share: tagged > 0 ? stats.count / tagged : 0,
    from: ms(stats.first_capture),
    to: ms(stats.last_capture),
  };
}

/**
 * The whole shelf, for one source and one sort order.
 *
 * Gear with nothing in the active source is dropped rather than drawn at zero:
 * its link would open an empty grid, which is exactly the dead end the source
 * tabs exist to prevent. It reappears on another tab.
 */
export function buildKit(
  cameras: GearCamera[],
  source: LibrarySource,
  sort: Sort,
): Kit {
  const cmp = sortFor(sort, source);
  const live = cameras.filter((c) => statsFor(c, source).count > 0).sort(cmp);
  const busiest = live.reduce((m, c) => Math.max(m, statsFor(c, source).count), 0);

  const bodies = live.map((camera): KitBody => {
    const stats = statsFor(camera, source);
    const base = effectiveLibrarySource(source, camera.incoming.count);
    const other =
      source === "all" ? null : camera[source === "incoming" ? "gallery" : "incoming"];
    const lensRows = camera.lenses.filter((l) => statsFor(l, source).count > 0).sort(cmp);
    const tagged = lensRows.reduce((s, l) => s + statsFor(l, source).count, 0);
    const kind = cameraKind(camera.name);
    const lenses = lensRows.map((l) => buildLens(l, camera.name, source, tagged));
    const untagged = stats.count - tagged;
    // The slices of this body, always summing to its own total.
    const parts: KitPart[] = lenses.map((l) => ({
      key: l.key,
      label: l.label,
      count: l.stats.count,
      share: stats.count > 0 ? l.stats.count / stats.count : 0,
      href: l.href,
      tip: l.tip,
    }));
    if (untagged > 0) {
      parts.push({
        key: "__untagged",
        label: "No lens recorded",
        count: untagged,
        share: stats.count > 0 ? untagged / stats.count : 0,
        href: null,
        tip: "These files carry no lens tag, so there is nothing to filter on.",
      });
    }
    return {
      name: camera.name,
      label: camera.label,
      kind,
      kindLabel: CAMERA_KINDS[kind],
      stats,
      href: gridHref(base, camera.name),
      years: years(stats.first_capture, stats.last_capture),
      shutter: shutterLine(camera),
      shutterCount: camera.shutter_count,
      shutterAt: asOf(camera.shutter_count_at),
      split: splitLine(stats),
      elsewhere: elsewhereLine(other, source === "gallery" ? "gallery" : "incoming"),
      untagged,
      lenses,
      parts,
      share: busiest > 0 ? stats.count / busiest : 0,
      // The raw EXIF device string is the filter value and the only unambiguous
      // name a body has — worth a tooltip wherever the label was prettified.
      tip: camera.label === camera.name ? camera.name : `${camera.name}\n${camera.label}`,
      from: ms(stats.first_capture),
      to: ms(stats.last_capture),
    };
  });

  const dates = bodies.flatMap((b) => [b.from, b.to]).filter((t): t is number => t != null);
  const focals = bodies
    .flatMap((b) => b.lenses)
    .flatMap((l) => [l.optics.focalMin, l.optics.focalMax])
    .filter((f): f is number => f != null && f > 0);
  const apertures = bodies
    .flatMap((b) => b.lenses)
    .map((l) => l.optics.aperture)
    .filter((a): a is number => a != null && a > 0);

  return {
    bodies,
    lensCount: new Set(bodies.flatMap((b) => b.lenses.map((l) => l.key))).size,
    totalFrames: bodies.reduce((s, b) => s + b.stats.count, 0),
    span: dates.length > 0 ? { from: Math.min(...dates), to: Math.max(...dates) } : null,
    focal:
      focals.length > 0 ? { min: Math.min(...focals), max: Math.max(...focals) } : null,
    aperture:
      apertures.length > 0
        ? { min: Math.min(...apertures), max: Math.max(...apertures) }
        : null,
  };
}
