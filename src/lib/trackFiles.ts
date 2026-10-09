// What a file handed to the GPS-track import IS, said before anything is sent
// — the browser half of lib/trackParse.ts. Pure and dependency-free (no zone
// tables), so the settings page can tell "this is locations.json, the steps
// are missing" the moment a file is chosen, instead of after a round-trip.
// trackParse.ts stays the authority: this only names and counts.

export type TrackFileSlot = "positions" | "steps" | "gpx";

export type TrackFileInfo =
  | {
      ok: true;
      name: string;
      slot: TrackFileSlot;
      /** Timed positions (positions, gpx) or dated steps (steps). */
      count: number;
      /** First and last instant, epoch ms; null when none is readable. */
      from: number | null;
      to: number | null;
      /** The trip's or the GPX's own title, when it carries one. */
      title: string | null;
    }
  | { ok: false; name: string; error: string };

function epochMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e11 ? v * 1000 : v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return epochMs(n);
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

function span(times: (number | null)[]): { from: number | null; to: number | null } {
  let from: number | null = null;
  let to: number | null = null;
  for (const t of times) {
    if (t == null) continue;
    if (from == null || t < from) from = t;
    if (to == null || t > to) to = t;
  }
  return { from, to };
}

const located = (e: unknown): e is Record<string, unknown> =>
  !!e &&
  typeof e === "object" &&
  Number.isFinite(Number((e as Record<string, unknown>).lat)) &&
  Number.isFinite(Number((e as Record<string, unknown>).lon));

export function identifyTrackFile(name: string, raw: string): TrackFileInfo {
  const text = raw.replace(/^﻿/, "").trim();
  if (!text) return { ok: false, name, error: "the file is empty" };
  if (text.startsWith("<")) {
    if (!/<gpx\b/i.test(text)) return { ok: false, name, error: "an XML file that is not GPX" };
    const times = [...text.matchAll(/<time>\s*([^<]+?)\s*<\/time>/g)].map((m) => epochMs(m[1]));
    const count = (text.match(/<trkpt\b/gi) ?? []).length + (text.match(/<wpt\b/gi) ?? []).length;
    if (!count) return { ok: false, name, error: "a GPX file with no point" };
    return {
      ok: true,
      name,
      slot: "gpx",
      count,
      ...span(times),
      title: /<name>\s*([^<]+?)\s*<\/name>/.exec(text)?.[1] ?? null,
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, name, error: "neither JSON nor GPX" };
  }
  const o = (json ?? {}) as Record<string, unknown>;
  const list = Array.isArray(json) ? json : Array.isArray(o.locations) ? o.locations : null;
  if (list) {
    const pts = list.filter(located);
    if (!pts.length) return { ok: false, name, error: "no {lat, lon, time} position in it" };
    return {
      ok: true,
      name,
      slot: "positions",
      count: pts.length,
      ...span(pts.map((p) => epochMs(p.time ?? p.t ?? p.timestamp))),
      title: null,
    };
  }
  const steps = Array.isArray(o.all_steps) ? o.all_steps : Array.isArray(o.steps) ? o.steps : null;
  if (steps) {
    const dated = steps.filter((s) => s && typeof s === "object" && epochMs((s as Record<string, unknown>).start_time) != null);
    if (!dated.length) return { ok: false, name, error: "a trip file with no dated step" };
    return {
      ok: true,
      name,
      slot: "steps",
      count: dated.length,
      ...span(dated.map((s) => epochMs((s as Record<string, unknown>).start_time))),
      title: typeof o.name === "string" && o.name.trim() ? o.name.trim() : null,
    };
  }
  return { ok: false, name, error: "not a Polarsteps or GPX file" };
}
