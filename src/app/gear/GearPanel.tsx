"use client";

// The /gear shelf: every camera body the library was shot with, drawn as
// line-art (cf. CameraArt), with the glass it was used with as a compact list
// of rows (cf. LensArt, in miniature). Bodies come first and lenses hang off
// them, because that is how the kit is actually held: a lens count only means
// something once you know which body it was mounted on.
//
// The layout is one design at two breakpoints: on desktop the body keeps its
// catalogue-plate card in a sticky left column with the lens rows alongside;
// on narrow screens the card collapses into a horizontal band and the rows
// stack under it behind an indent rule, so a whole kit reads on one phone
// screen. The rows keep spec + count; secondary meta (split, "more elsewhere",
// the merged EXIF spellings) folds into the row's tooltip.
//
// A gear card is a shortcut, not a museum label — tapping a body opens the grid
// filtered on it, tapping a lens opens the same grid narrowed to that body AND
// that lens, so "what did I shoot on the 56 on the X-T5" is one click away.
//
// Which grid? The library has two halves — Incoming (still to cull) and the
// Gallery (finalized exports) — and most gear has frames in BOTH. Merging them
// would make every card lie in one direction or the other: the count would
// include media the linked grid can't show. So the shelf carries the same
// Incoming/Gallery tabs as the Library, and the choice drives both the counts
// and where every card points (cf. lib/gear.ts, which tallies per source).
import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { fetchJson } from "@/lib/fetchJson";
import { lensArt, lensSpec } from "@/lib/gearArt";
import type {
  GearCamera,
  GearLens,
  GearResponse,
  GearSource,
  GearStats,
} from "@/lib/gearTypes";
import { EmptyState, Icons, LoadingState } from "@/app/ui";
import CameraArt from "./CameraArt";
import LensArt from "./LensArt";

type Sort = "used" | "recent";

const SOURCES: { key: GearSource; label: string; title: string }[] = [
  { key: "incoming", label: "Incoming", title: "Media still to cull" },
  { key: "gallery", label: "Gallery", title: "Finalized exports" },
];

const SORTS: { key: Sort; label: string; title: string }[] = [
  { key: "used", label: "Most used", title: "Busiest gear first" },
  { key: "recent", label: "Recent", title: "Most recently used first" },
];

// The chosen half of the library sticks between visits — it is a way of working
// ("I live in Incoming"), not a per-visit decision.
const SOURCE_KEY = "winnow.gear.source";

const num = (n: number) => n.toLocaleString();

/**
 * Where a piece of gear's frames live, for the active source. `lenses` is every
 * raw EXIF spelling the card merged (cf. lib/lensLabels.ts) — the filter is
 * multi-value, so one card still reaches all of its frames.
 */
function href(source: GearSource, device: string, lenses?: string[]): string {
  const sp = new URLSearchParams({ device });
  if (lenses?.length) sp.set("lens", lenses.join(","));
  // Both targets seed their filters from the query string: Incoming through its
  // `[view]` route (Grid is the one that shows the frames themselves), the
  // Gallery tab through the same decode (cf. library/gallery/page.tsx).
  const base = source === "gallery" ? "/library/gallery" : "/library/incoming/grid";
  return `${base}?${sp.toString()}`;
}

/** "2019–2026" — the years a piece of gear was in service, from its frames. */
function years(first: string | null, last: string | null): string | null {
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

/** Photos, videos, or a mixed bag — number and unit, kept apart so the lens
 * rows can stack them into an aligned figures column. */
function countParts(s: GearStats): { n: string; unit: string } {
  if (s.videos === 0)
    return { n: num(s.photos), unit: s.photos === 1 ? "photo" : "photos" };
  if (s.photos === 0)
    return { n: num(s.videos), unit: s.videos === 1 ? "video" : "videos" };
  return { n: num(s.count), unit: "media" };
}

/** The same tally as one string — the pill on the camera card. */
function countLabel(s: GearStats): string {
  const { n, unit } = countParts(s);
  return `${n} ${unit}`;
}

/** Mixed libraries get the split spelled out; single-medium ones don't need it. */
function splitLine(s: GearStats): string | null {
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
function shutterLine(c: GearCamera): string | null {
  if (c.shutter_count == null) return null;
  const line = `${num(c.shutter_count)} shutter actuations`;
  if (!c.shutter_count_at) return line;
  const d = new Date(c.shutter_count_at);
  if (!Number.isFinite(d.getTime())) return line;
  const asOf = d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
  return `${line} · ${asOf}`;
}

/** "…and 3 more elsewhere" — what the other half of the library still holds. */
function elsewhereLine(other: GearStats, source: GearSource): string | null {
  if (other.count === 0) return null;
  const where = source === "gallery" ? "Incoming" : "the Gallery";
  return `${num(other.count)} more in ${where}`;
}

/**
 * The body's card: a catalogue-plate portrait in the desktop column, a
 * horizontal band above its lens list on narrow screens — same markup, the
 * stylesheet turns the column into a row. `extra` meta (the media split, the
 * other tab's tally) hides on the band, where the years are all that fit.
 */
function CameraCard({
  href,
  art,
  name,
  label,
  count,
  meta,
  extra,
}: {
  href: string;
  art: ReactNode;
  /** Raw EXIF string — surfaced as the tooltip when the label was prettified. */
  name: string;
  label: string;
  count: string;
  meta: (string | null)[];
  extra: (string | null)[];
}) {
  const lines = meta.filter(Boolean) as string[];
  const extras = extra.filter(Boolean) as string[];
  return (
    <Link href={href} className="gear-card" title={name === label ? undefined : name}>
      <span className="gear-art gear-art-camera">{art}</span>
      <span className="gear-card-text">
        <span className="gear-name">{label}</span>
        {(lines.length > 0 || extras.length > 0) && (
          <span className="gear-meta">
            {lines.map((l) => (
              <span key={l} className="gear-meta-line">
                {l}
              </span>
            ))}
            {extras.map((l) => (
              <span key={l} className="gear-meta-line gear-meta-extra">
                {l}
              </span>
            ))}
          </span>
        )}
      </span>
      <span className="pill gear-count">{count}</span>
    </Link>
  );
}

/** Busiest first / most recently used first, both read off the active source. */
function sortFor(sort: Sort, source: GearSource) {
  return <T extends { label: string; incoming: GearStats; gallery: GearStats }>(
    a: T,
    b: T,
  ) =>
    sort === "recent"
      ? (b[source].last_capture ?? "").localeCompare(a[source].last_capture ?? "") ||
        a.label.localeCompare(b.label)
      : b[source].count - a[source].count || a.label.localeCompare(b.label);
}

export default function GearPanel() {
  const [data, setData] = useState<GearResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>("used");
  const [source, setSource] = useState<GearSource>("incoming");

  useEffect(() => {
    fetchJson<GearResponse>("/api/gear")
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load"));
  }, []);

  // Restore / persist the chosen half of the library (client-only, so the first
  // render matches the server's).
  useEffect(() => {
    const saved = localStorage.getItem(SOURCE_KEY);
    if (saved === "incoming" || saved === "gallery") setSource(saved);
  }, []);
  useEffect(() => {
    localStorage.setItem(SOURCE_KEY, source);
  }, [source]);

  // Gear with nothing in the active source is dropped rather than drawn at zero:
  // its card would link to an empty grid, which is exactly the dead end the
  // source tabs exist to prevent. It reappears on the other tab.
  const cameras = useMemo<GearCamera[]>(() => {
    const cmp = sortFor(sort, source);
    return (data?.cameras ?? [])
      .filter((c) => c[source].count > 0)
      .map((c) => ({
        ...c,
        lenses: c.lenses.filter((l) => l[source].count > 0).sort(cmp),
      }))
      .sort(cmp);
  }, [data, sort, source]);

  if (error) {
    return (
      <div className="empty-state error" role="alert">
        {error}
      </div>
    );
  }
  if (!data) return <LoadingState label="Reading the EXIF…" />;

  const lensCount = new Set(cameras.flatMap((c) => c.lenses.map((l) => l.key))).size;
  const totalFrames = cameras.reduce((s, c) => s + c[source].count, 0);
  // Empty tab vs empty library: only the second one is "no gear yet".
  const otherTotal = (data.cameras ?? []).reduce(
    (s, c) => s + c.incoming.count + c.gallery.count,
    0,
  );

  const head = (
    <div className="gear-head">
      <div className="tabs" role="group" aria-label="Which half of the library">
        {SOURCES.map((s) => (
          <button
            key={s.key}
            className={`tab${source === s.key ? " active" : ""}`}
            onClick={() => setSource(s.key)}
            aria-pressed={source === s.key}
            title={s.title}
          >
            {s.label}
          </button>
        ))}
      </div>
      <span className="hint">
        {cameras.length} {cameras.length === 1 ? "body" : "bodies"} · {lensCount}{" "}
        {lensCount === 1 ? "lens" : "lenses"} · {num(totalFrames)} media
      </span>
      <span className="spacer" />
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

  if (cameras.length === 0) {
    return (
      <div className="gear-shelf">
        {head}
        <EmptyState
          icon={Icons.photos}
          title={otherTotal > 0 ? "Nothing here yet" : "No gear yet"}
          hint={
            otherTotal > 0
              ? `No media in ${source === "gallery" ? "the Gallery" : "Incoming"} carry camera EXIF — try the other tab.`
              : "Cameras and lenses appear here as soon as indexed media carry EXIF maker/model tags."
          }
        />
      </div>
    );
  }

  return (
    <div className="gear-shelf">
      {head}

      {cameras.map((c) => (
        <Body key={c.name} camera={c} source={source} />
      ))}
    </div>
  );
}

/** One body and the glass that rode on it — the unit the shelf is built from. */
function Body({ camera, source }: { camera: GearCamera; source: GearSource }) {
  const stats = camera[source];
  const other = camera[source === "incoming" ? "gallery" : "incoming"];
  // Frames whose files carry no lens tag: the body's total minus what the lens
  // cards account for. Named rather than hidden, so the numbers add up.
  const tagged = camera.lenses.reduce((s, l) => s + l[source].count, 0);
  const untagged = stats.count - tagged;

  return (
    <section className="gear-body">
      <div className="gear-body-figure">
        <CameraCard
          href={href(source, camera.name)}
          art={<CameraArt name={camera.name} />}
          name={camera.name}
          label={camera.label}
          count={countLabel(stats)}
          extra={[splitLine(stats), elsewhereLine(other, source)]}
          meta={[
            years(stats.first_capture, stats.last_capture),
            splitLine(stats),
            shutterLine(camera),
            elsewhereLine(other, source),
          ]}
        />
      </div>

      <div className="gear-body-glass">
        <h3 className="gear-body-glass-head">
          {camera.lenses.length > 0
            ? `${camera.lenses.length} ${camera.lenses.length === 1 ? "lens" : "lenses"}`
            : "No lens recorded"}
          {untagged > 0 && (
            <span className="hint">
              {" "}
              · {num(untagged)} {untagged === 1 ? "frame" : "frames"} without a lens tag
            </span>
          )}
        </h3>
        {camera.lenses.length > 0 && (
          <div className="gear-rows">
            {camera.lenses.map((l) => (
              <LensRow key={l.key} lens={l} device={camera.name} source={source} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * One lens as a list row: miniature barrel, name + spec, count in an aligned
 * figures column. The years get a column of their own where the row is wide
 * enough; everything else the old card spelled out folds into the tooltip.
 */
function LensRow({
  lens,
  device,
  source,
}: {
  lens: GearLens;
  device: string;
  source: GearSource;
}) {
  const stats = lens[source];
  const other = lens[source === "incoming" ? "gallery" : "incoming"];
  // The spec line is derived, so a lens whose name states nothing ("E 18-55")
  // still shows the range its frames recorded.
  const spec =
    lensSpec(
      lensArt(lens.label, {
        focalMin: lens.focal_min,
        focalMax: lens.focal_max,
        aperture: lens.aperture_min,
      }),
    ) || null;
  const specLine = [
    spec,
    lens.names.length > 1 ? `${lens.names.length} EXIF names` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  // The tooltip carries every raw EXIF spelling this row merged — a merge is
  // always inspectable rather than something that just happened — plus the
  // meta the compact row no longer spells out.
  const tip = [
    lens.names.join(" · "),
    splitLine(stats),
    elsewhereLine(other, source),
  ]
    .filter(Boolean)
    .join("\n");
  const yr = years(stats.first_capture, stats.last_capture);
  const { n, unit } = countParts(stats);
  return (
    <Link href={href(source, device, lens.names)} className="gear-row" title={tip}>
      <span className="gear-row-art">
        <LensArt
          name={lens.label}
          focalMin={lens.focal_min}
          focalMax={lens.focal_max}
          aperture={lens.aperture_min}
        />
      </span>
      <span className="gear-row-text">
        <span className="gear-row-name">{lens.label}</span>
        {specLine && <span className="gear-row-spec">{specLine}</span>}
      </span>
      {yr && <span className="gear-row-years">{yr}</span>}
      <span className="gear-row-count">
        {n}
        <small>{unit}</small>
      </span>
    </Link>
  );
}
