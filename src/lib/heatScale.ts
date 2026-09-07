// The heatmap's measures and its colour scale — pure, no imports.
//
// Kept apart from `src/lib/heat.ts` (which reaches Postgres) because the four
// heatmap panels are client components and read this directly; the same split
// as `features.ts` / `featureGate.ts`, and for the same reason — `pg` must
// never enter the browser bundle.
//
// ## Why a measure list at all
//
// A heatmap whose only reading is "how many frames" is a stat page. The rung is
// a *question*, chosen once and answered by every panel at the same time — the
// calendar, the map and the matrix are never colouring different things.
//
// `backlog` is the one measure that is uniquely Winnow's: the project's job is
// triage, so a map of "these three weeks have never been looked at" is a work
// queue, not a statistic. It is the default for that reason.

/** What every panel counts over: an aggregate of some slice of the library. */
export type HeatCell = {
  /** Frames (RAW+JPEG pairs collapsed, like the Calendar). */
  c: number;
  /** Frames rated `pick`. */
  p: number;
  /** Frames never triaged — no ratings row, or `unrated`. */
  u: number;
};

export type MeasureId = "backlog" | "volume" | "keepers" | "rate";

/**
 * Keeper rate is the measure that flatters and lies: four frames and two picks
 * is not a 50 % day. Under this many frames it has no answer and draws neutral
 * — and the panel says so, because an automatic decision nobody can see is one
 * nobody trusts (the same rule the Timeline's granularity chip follows).
 */
export const RATE_FLOOR = 20;

export type Measure = {
  id: MeasureId;
  label: string;
  /** The legend's two ends, in words. */
  lo: string;
  hi: string;
  /** The value that colours a cell; `null` means "no answer", not "zero". */
  of: (x: HeatCell) => number | null;
  /** The tooltip's headline for this cell. */
  say: (x: HeatCell) => string;
};

const nf = new Intl.NumberFormat("en-US");

export const MEASURES: readonly Measure[] = [
  {
    id: "backlog",
    label: "Backlog",
    lo: "nothing left",
    hi: "a pile",
    of: (x) => x.u,
    say: (x) => `${nf.format(x.u)} still to cull`,
  },
  {
    id: "volume",
    label: "Volume",
    lo: "no frames",
    hi: "a heavy day",
    of: (x) => x.c,
    say: (x) => `${nf.format(x.c)} frames`,
  },
  {
    id: "keepers",
    label: "Keepers",
    lo: "no keepers",
    hi: "many keepers",
    of: (x) => x.p,
    say: (x) => `${nf.format(x.p)} picks`,
  },
  {
    id: "rate",
    label: "Keeper rate",
    lo: "low",
    hi: "high",
    of: (x) => (x.c < RATE_FLOOR ? null : x.p / x.c),
    say: (x) =>
      x.c < RATE_FLOOR
        ? `under ${RATE_FLOOR} frames — no rate`
        : `${Math.round((100 * x.p) / x.c)}% keepers`,
  },
];

export const DEFAULT_MEASURE: MeasureId = "backlog";

export function measureById(id: string | null | undefined): Measure {
  return MEASURES.find((m) => m.id === id) ?? MEASURES[0];
}

/** Add cells up. One function, so a month cell and a day cell agree. */
export function fold(cells: Iterable<HeatCell>): HeatCell {
  const o: HeatCell = { c: 0, p: 0, u: 0 };
  for (const x of cells) {
    o.c += x.c;
    o.p += x.p;
    o.u += x.u;
  }
  return o;
}

/**
 * A value and the visible maximum → a rung 0–4, or `null` for "no answer".
 *
 * Fixed fractions rather than quantiles on purpose: a quantile scale re-bins
 * itself when the filters change, so the same day changes colour without its
 * content changing — which makes the ramp unreadable across two views of the
 * library. The trade is that a single outlier flattens the rest; the tooltip
 * carries the number for exactly that case.
 */
export function rung(v: number | null, max: number): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  if (v <= 0 || max <= 0) return 0;
  const f = v / max;
  return f > 0.62 ? 4 : f > 0.36 ? 3 : f > 0.16 ? 2 : 1;
}

/** The CSS custom property a rung paints with (`null` → the neutral tone). */
export function rungVar(r: number | null): string {
  return r === null ? "var(--heat-none)" : `var(--heat-${r})`;
}

/** The largest value a set of cells reaches under a measure — the ramp's top. */
export function maxOf(cells: Iterable<HeatCell>, m: Measure): number {
  let max = 0;
  for (const x of cells) {
    const v = m.of(x);
    if (v !== null && v > max) max = v;
  }
  return max;
}
