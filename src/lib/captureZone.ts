// Which calendar day a frame was taken on — the PURE half (no DB, no I/O).
//
// `assets.captured_at` keeps what the file states; the day is decided by the
// UTC offset of the PLACE the frame was taken in, at that instant (migration
// 0046). This module is the arithmetic every writer shares: the indexer, the
// backfill (lib/captureDays.ts) and the track import (lib/trackImport.ts).
//
// The rule, in one line: the place decides, never the camera. A Sony left on
// Brisbane time in Paris still writes `+10:00`; the iPhone in the same pocket
// knows where it is. So an offset read from a position (the frame's own, a
// track's, a neighbour's) always beats the camera's OffsetTimeOriginal.
import tzLookup from "@photostructure/tz-lookup";

export type CapturedAtSource = "exif" | "exif-wall" | "file";
export type OffsetSource = "gps" | "track" | "neighbour" | "exif";

/** Strongest first: a higher rank never yields to a lower one. */
const RANK: Record<OffsetSource, number> = {
  gps: 4,
  track: 3,
  neighbour: 2,
  exif: 1,
};

/** True when an offset from `next` may replace one from `current`. */
export function outranks(
  next: OffsetSource,
  current: OffsetSource | null | undefined,
): boolean {
  return current == null || RANK[next] >= RANK[current];
}

/**
 * The IANA zone covering a position, or null for a point the lookup refuses
 * (out of range, NaN). Offline: the polygons ship inside the package.
 */
export function zoneAt(lat: number, lon: number): string | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  try {
    return tzLookup(lat, lon);
  } catch {
    return null;
  }
}

/**
 * A zone's UTC offset at one instant, in minutes east of UTC (DST included):
 * Australia/Melbourne is +600 in July and +660 in December.
 */
export function zoneOffsetMinutes(zone: string, instant: Date): number | null {
  if (!Number.isFinite(instant.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(instant);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const asUtc = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour"),
      get("minute"),
      get("second"),
    );
    // Whole minutes: sub-minute residue is the instant's own seconds fraction.
    return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000);
  } catch {
    return null;
  }
}

/** The place offset at a position and instant, or null. */
export function placeOffsetMinutes(
  lat: number,
  lon: number,
  instant: Date,
): number | null {
  const zone = zoneAt(lat, lon);
  return zone ? zoneOffsetMinutes(zone, instant) : null;
}

/**
 * The instant a stored captured_at stands for. An 'exif-wall' value is a
 * local wall clock stored as UTC, so its instant is that clock minus the
 * place's offset — only knowable once an offset is.
 */
export function trueInstant(
  capturedAt: Date,
  source: CapturedAtSource | null | undefined,
  offsetMin: number | null | undefined,
): Date {
  if (source === "exif-wall" && offsetMin != null)
    return new Date(capturedAt.getTime() - offsetMin * 60000);
  return capturedAt;
}

/**
 * The local calendar day (`YYYY-MM-DD`) — the exact mirror of the
 * `winnow_set_capture_parts` trigger (migration 0046), kept here so the rule is
 * testable and the dry runs can say which days WOULD change.
 */
export function localDay(
  capturedAt: Date,
  source: CapturedAtSource | null | undefined,
  offsetMin: number | null | undefined,
): string {
  const shift = source === "exif-wall" ? 0 : (offsetMin ?? 0);
  return new Date(capturedAt.getTime() + shift * 60000).toISOString().slice(0, 10);
}

/** The subset of exiftool-vendored's ExifDateTime this module reads. */
export type ExifTimeLike = {
  hasZone?: boolean;
  tzoffsetMinutes?: number;
  inferredZone?: boolean;
};

export type CaptureClassification = {
  /** How the chosen tag was read. */
  source: CapturedAtSource;
  /** The camera's own stated offset, when it stated one. */
  exifOffsetMin: number | null;
};

/**
 * Classify the date tag readMetadata picked. A zone the camera WROTE
 * (OffsetTimeOriginal) is kept as the weak 'exif' offset; a zone exiftool
 * INFERRED (from GPS, or the UTC convention of QuickTime video dates) makes the
 * value an instant but says nothing about the local offset — the position
 * pass decides that.
 */
export function classifyCaptureTime(
  tag: ExifTimeLike | null | undefined,
  tzSource: string | null | undefined,
): CaptureClassification {
  if (!tag || typeof tag !== "object") return { source: "file", exifOffsetMin: null };
  if (!tag.hasZone) return { source: "exif-wall", exifOffsetMin: null };
  const written =
    !tag.inferredZone &&
    typeof tzSource === "string" &&
    /offsettime|timezone/i.test(tzSource) &&
    Number.isFinite(tag.tzoffsetMinutes);
  return {
    source: "exif",
    exifOffsetMin: written ? (tag.tzoffsetMinutes as number) : null,
  };
}

/** One frame as the zone resolution sees it. */
export type ZoneInput = {
  capturedAt: Date;
  capturedAtSource: CapturedAtSource | null;
  lat: number | null;
  lon: number | null;
  offsetMin: number | null;
  offsetSource: OffsetSource | null;
  exifOffsetMin?: number | null;
};

export type ZoneDecision = {
  offsetMin: number | null;
  offsetSource: OffsetSource | null;
};

/**
 * Decide a frame's offset from what is known about the frame itself: its own
 * position first, then whatever stronger-or-equal source it already holds,
 * then the camera's word. Neighbours and tracks are applied by their own
 * passes through `outranks`.
 *
 * An unclassified row (indexed before 0046) is only resolved from its position
 * when that position came from the file itself — exiftool zoned such a time
 * from the same GPS, so it is an instant. Anything else waits for the backfill
 * to read the file's date tags.
 */
export function decideOwnZone(
  f: ZoneInput,
  opts: { positionFromFile?: boolean } = {},
): ZoneDecision {
  const keep: ZoneDecision = { offsetMin: f.offsetMin, offsetSource: f.offsetSource };
  const classified = f.capturedAtSource != null || opts.positionFromFile === true;
  if (classified && f.lat != null && f.lon != null) {
    // For a wall clock the instant needs an offset to exist; the zone's offset
    // a few hours either side of the wall time is the same except across a DST
    // edge, so the wall time read as UTC is close enough to pick it.
    const off = placeOffsetMinutes(f.lat, f.lon, f.capturedAt);
    if (off != null && outranks("gps", f.offsetSource)) {
      const exact =
        f.capturedAtSource === "exif-wall"
          ? (placeOffsetMinutes(
              f.lat,
              f.lon,
              new Date(f.capturedAt.getTime() - off * 60000),
            ) ?? off)
          : off;
      return { offsetMin: exact, offsetSource: "gps" };
    }
  }
  if (f.offsetSource && f.offsetSource !== "exif") return keep;
  if (f.exifOffsetMin != null) return { offsetMin: f.exifOffsetMin, offsetSource: "exif" };
  return keep;
}
