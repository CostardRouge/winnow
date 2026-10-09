// An imported GPS track, read — the PURE half of lib/trackImport.ts.
//
// Three shapes are understood, told apart by content rather than by name:
//   - a Polarsteps export: `locations.json` ({ locations: [{lat, lon, time}] },
//     unix seconds) and/or `trip.json` (`all_steps`, each with a start_time, a
//     timezone_id and a located place — the zone timeline of the trip);
//   - a GPX file (<trkpt lat lon><time>…, also <rtept>/<wpt> with a time);
//   - a plain JSON array of {lat, lon, time} (seconds, milliseconds or ISO).
//
// Nothing here touches the database. Garbage is refused with a reason rather
// than half-read: a track that silently dropped half its points would place
// frames wrongly with full confidence.
import { placeOffsetMinutes, zoneOffsetMinutes } from "./captureZone";

export type TrackPoint = { t: number; lat: number; lon: number };
export type TrackStep = {
  t: number;
  zone: string | null;
  name: string;
  lat: number | null;
  lon: number | null;
};
export type ParsedTrack = {
  kind: "polarsteps" | "gpx" | "json";
  name: string | null;
  points: TrackPoint[];
  steps: TrackStep[];
};

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const validLatLon = (lat: unknown, lon: unknown) =>
  finite(lat) && finite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);

/** Seconds, milliseconds or an ISO string → epoch ms; null if none of those. */
export function toEpochMs(v: unknown): number | null {
  if (finite(v)) {
    // Before 2001-09-09 in ms is 1e12; anything smaller is seconds.
    const ms = v < 1e11 ? v * 1000 : v;
    return ms > 0 ? Math.round(ms) : null;
  }
  if (typeof v === "string" && v.trim()) {
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function sortDedupe(points: TrackPoint[]): TrackPoint[] {
  points.sort((a, b) => a.t - b.t);
  const out: TrackPoint[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && last.t === p.t) continue;
    out.push(p);
  }
  return out;
}

function readPoints(arr: unknown[]): TrackPoint[] {
  const out: TrackPoint[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const lat = r.lat ?? r.latitude;
    const lon = r.lon ?? r.lng ?? r.longitude;
    const t = toEpochMs(r.time ?? r.timestamp ?? r.t);
    if (t == null || !validLatLon(lat, lon)) continue;
    out.push({ t, lat: lat as number, lon: lon as number });
  }
  return out;
}

function readSteps(arr: unknown[]): TrackStep[] {
  const out: TrackStep[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const s = raw as Record<string, unknown>;
    if (s.is_deleted === true) continue;
    const t = toEpochMs(s.start_time);
    if (t == null) continue;
    const loc = (s.location ?? {}) as Record<string, unknown>;
    const ok = validLatLon(loc.lat, loc.lon);
    out.push({
      t,
      zone: typeof s.timezone_id === "string" && s.timezone_id ? s.timezone_id : null,
      name: String(s.display_name ?? s.name ?? loc.name ?? "").trim(),
      lat: ok ? (loc.lat as number) : null,
      lon: ok ? (loc.lon as number) : null,
    });
  }
  return out.sort((a, b) => a.t - b.t);
}

function parseGpx(xml: string): TrackPoint[] {
  const out: TrackPoint[] = [];
  const re = /<(trkpt|rtept|wpt)\b([^>]*)>([\s\S]*?)<\/\1>/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const attrs = m[2];
    const lat = Number(/\blat\s*=\s*["']([^"']+)["']/.exec(attrs)?.[1]);
    const lon = Number(/\blon\s*=\s*["']([^"']+)["']/.exec(attrs)?.[1]);
    const time = /<time>\s*([^<]+?)\s*<\/time>/.exec(m[3])?.[1];
    const t = toEpochMs(time);
    if (t == null || !validLatLon(lat, lon)) continue;
    out.push({ t, lat, lon });
  }
  return out;
}

export class TrackParseError extends Error {}

/**
 * Read any number of files (name + text) into ONE track. Polarsteps' two files
 * combine; several GPX files concatenate. Mixing a Polarsteps export with a
 * GPX is refused — two clocks for one period is a question, not an answer.
 */
export function parseTrackFiles(files: { name: string; text: string }[]): ParsedTrack {
  let points: TrackPoint[] = [];
  let steps: TrackStep[] = [];
  let name: string | null = null;
  const kinds = new Set<ParsedTrack["kind"]>();
  for (const f of files) {
    const text = f.text.replace(/^﻿/, "").trim();
    if (!text) continue;
    if (text.startsWith("<")) {
      if (!/<gpx\b/i.test(text)) throw new TrackParseError(`${f.name}: an XML file that is not GPX`);
      const pts = parseGpx(text);
      if (!pts.length) throw new TrackParseError(`${f.name}: a GPX file with no timed point`);
      points = points.concat(pts);
      kinds.add("gpx");
      name ??= /<name>\s*([^<]+?)\s*<\/name>/.exec(text)?.[1] ?? null;
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new TrackParseError(`${f.name}: neither JSON nor GPX`);
    }
    if (Array.isArray(json)) {
      const pts = readPoints(json);
      if (!pts.length) throw new TrackParseError(`${f.name}: a JSON list with no {lat, lon, time} entry`);
      points = points.concat(pts);
      kinds.add("json");
      continue;
    }
    const o = (json ?? {}) as Record<string, unknown>;
    if (Array.isArray(o.locations)) {
      const pts = readPoints(o.locations);
      if (!pts.length) throw new TrackParseError(`${f.name}: a locations file with no usable point`);
      points = points.concat(pts);
      kinds.add("polarsteps");
      continue;
    }
    if (Array.isArray(o.all_steps) || Array.isArray(o.steps)) {
      const st = readSteps((o.all_steps ?? o.steps) as unknown[]);
      if (!st.length) throw new TrackParseError(`${f.name}: a trip file with no dated step`);
      steps = steps.concat(st);
      if (typeof o.name === "string" && o.name.trim()) name = o.name.trim();
      kinds.add("polarsteps");
      continue;
    }
    throw new TrackParseError(`${f.name}: not a Polarsteps, GPX or {lat, lon, time} file`);
  }
  if (kinds.size > 1)
    throw new TrackParseError("one track per import: these files come from different sources");
  // A Polarsteps trip with no locations file still has its steps' own places.
  if (!points.length)
    points = steps
      .filter((s) => s.lat != null && s.lon != null)
      .map((s) => ({ t: s.t, lat: s.lat as number, lon: s.lon as number }));
  if (!points.length) throw new TrackParseError("no timed position in these files");
  return {
    kind: [...kinds][0] ?? "polarsteps",
    name,
    points: sortDedupe(points),
    steps: steps.sort((a, b) => a.t - b.t),
  };
}

export type TrackFix = {
  lat: number;
  lon: number;
  /** Minutes between the frame and the fix(es) it rests on. */
  gapMin: number;
  /** interpolated: between two close fixes; still: between two fixes hours
   *  apart but at the same spot (the traveller stayed); nearest: one fix. */
  method: "interpolated" | "still" | "nearest";
};

export type MatchOptions = {
  /** Interpolate only between two fixes at most this far apart. */
  maxBracketMin?: number;
  /** Otherwise take the nearest fix within this many minutes. */
  maxNearestMin?: number;
  /** Never interpolate across a leg faster than this (a flight). */
  maxKmh?: number;
  /** Two fixes up to this many hours apart but within `maxStillKm` of each
   *  other mean the traveller stayed put in between: Polarsteps records a
   *  fix when moving and few when not, so a camp or a town visit is exactly
   *  that shape. */
  maxStillHours?: number;
  maxStillKm?: number;
};

const R = 6371;
function km(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
export { km as distanceKm };

/** Index of the last point at or before `t` (-1 when none). */
function floorIndex(points: TrackPoint[], t: number): number {
  let lo = 0;
  let hi = points.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/**
 * Where the track was at instant `t`: linear between the two fixes around it
 * when they are close in time and slow enough to be a road, else the nearest
 * fix when it is within minutes, else nothing — a gap in the track is not a
 * position.
 */
export function positionAt(
  points: TrackPoint[],
  t: number,
  opts: MatchOptions = {},
): TrackFix | null {
  const maxBracket = (opts.maxBracketMin ?? 60) * 60000;
  const maxNearest = (opts.maxNearestMin ?? 15) * 60000;
  const maxKmh = opts.maxKmh ?? 200;
  const maxStill = (opts.maxStillHours ?? 12) * 3600000;
  const maxStillKm = opts.maxStillKm ?? 2;
  if (!points.length) return null;
  const i = floorIndex(points, t);
  const a = i >= 0 ? points[i] : null;
  const b = i + 1 < points.length ? points[i + 1] : null;
  if (a && a.t === t) return { lat: a.lat, lon: a.lon, gapMin: 0, method: "nearest" };
  if (a && b && b.t - a.t <= maxBracket) {
    const hours = (b.t - a.t) / 3600000;
    if (hours <= 0 || km(a, b) / hours <= maxKmh) {
      const f = (t - a.t) / (b.t - a.t);
      return {
        lat: a.lat + (b.lat - a.lat) * f,
        lon: a.lon + (b.lon - a.lon) * f,
        gapMin: Math.round(Math.max(t - a.t, b.t - t) / 60000),
        method: "interpolated",
      };
    }
  }
  if (a && b && b.t - a.t <= maxStill && km(a, b) <= maxStillKm) {
    const f = (t - a.t) / (b.t - a.t);
    return {
      lat: a.lat + (b.lat - a.lat) * f,
      lon: a.lon + (b.lon - a.lon) * f,
      gapMin: Math.round(Math.max(t - a.t, b.t - t) / 60000),
      method: "still",
    };
  }
  const da = a ? t - a.t : Infinity;
  const db = b ? b.t - t : Infinity;
  const near = da <= db ? a : b;
  const d = Math.min(da, db);
  if (near && d <= maxNearest)
    return { lat: near.lat, lon: near.lon, gapMin: Math.round(d / 60000), method: "nearest" };
  return null;
}

/**
 * The traveller's UTC offset at instant `t`, from the steps' zone timeline
 * (the zone of the last step started at or before it), else from the nearest
 * fix within `maxHours`. Null when neither knows.
 */
export function offsetAt(
  track: ParsedTrack,
  t: number,
  maxHours = 12,
): number | null {
  const zoned = track.steps.filter((s) => s.zone);
  if (zoned.length && t >= zoned[0].t - 12 * 3600000) {
    let step = zoned[0];
    for (const s of zoned) {
      if (s.t <= t) step = s;
      else break;
    }
    const off = zoneOffsetMinutes(step.zone as string, new Date(t));
    if (off != null) return off;
  }
  const i = floorIndex(track.points, t);
  const cands = [track.points[i], track.points[i + 1]].filter(Boolean) as TrackPoint[];
  let best: TrackPoint | null = null;
  for (const p of cands) if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
  if (best && Math.abs(best.t - t) <= maxHours * 3600000)
    return placeOffsetMinutes(best.lat, best.lon, new Date(t));
  return null;
}
