"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * Dual-thumb range filter used across the library's numeric facets (ISO, focal
 * length, aperture, file size…). It replaces the old bare pair of min/max number
 * fields: you now *see* the full span the dataset covers and where your selected
 * window sits inside it, and you drag two handles to narrow it.
 *
 * Design notes:
 *  - Built from two overlaid native `<input type="range">` — the same primitive
 *    already used in ControlPanel, so keyboard support and `accent-color` come
 *    for free and it stays consistent with the rest of the app.
 *  - `scale="iso" | "aperture"` snaps the handles to the standard photographic
 *    stops (100/200/400…, f/1.4/2/2.8…) so a drag never lands on a bastard value.
 *    `scale="linear"` (the default) runs continuously over the domain.
 *  - The two number fields are kept for precise entry and accessibility. Typing
 *    an exact value is the escape hatch when snapping is too coarse — the field
 *    commits the raw number, the handle just settles on the nearest stop.
 *  - An empty side means "no bound": a handle parked on the domain edge emits
 *    `undefined`, so a full-width selection is the same as no filter at all.
 *  - When no dataset `bounds` are available (e.g. sharpness has no facet range),
 *    it degrades to the plain number-field pair — zero regression.
 */

// Standard full-stop photographic scales. The slider snaps to these; the number
// fields still accept any value in between.
const ISO_STOPS = [
  50, 100, 200, 400, 800, 1600, 3200, 6400, 12800, 25600, 51200, 102400,
];
const APERTURE_STOPS = [1, 1.4, 2, 2.8, 4, 5.6, 8, 11, 16, 22, 32];

export type RangeScale = "linear" | "iso" | "aperture";

type Bounds = { min: number; max: number };

/** Slider position ⇄ real value mapping for one facet. */
type Model = {
  sliderMin: number;
  sliderMax: number;
  sliderStep: number;
  toValue: (pos: number) => number; // slider position → real value
  toPos: (v: number) => number; // real value → nearest slider position (clamped)
};

/** Nearest index into an ascending array. */
function nearestIndex(stops: number[], v: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < stops.length; i++) {
    const d = Math.abs(stops[i] - v);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Clamp a stop grid to the values needed to fully cover [lo, hi]. */
function coveringStops(base: number[], lo: number, hi: number): number[] {
  const loStop = [...base].reverse().find((v) => v <= lo) ?? base[0];
  const hiStop = base.find((v) => v >= hi) ?? base[base.length - 1];
  const stops = base.filter((v) => v >= loStop && v <= hiStop);
  return stops.length >= 2 ? stops : base.slice();
}

function buildModel(scale: RangeScale, bounds: Bounds, step: number): Model {
  if (scale === "iso" || scale === "aperture") {
    const stops = coveringStops(
      scale === "iso" ? ISO_STOPS : APERTURE_STOPS,
      bounds.min,
      bounds.max,
    );
    return {
      sliderMin: 0,
      sliderMax: stops.length - 1,
      sliderStep: 1,
      toValue: (pos) => stops[Math.max(0, Math.min(stops.length - 1, Math.round(pos)))],
      toPos: (v) => nearestIndex(stops, v),
    };
  }
  return {
    sliderMin: bounds.min,
    sliderMax: bounds.max,
    sliderStep: step,
    toValue: (pos) => pos,
    toPos: (v) => Math.max(bounds.min, Math.min(bounds.max, v)),
  };
}

function defaultFormat(v: number, unit?: string): string {
  const n = Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  if (unit === "f/") return `f/${n}`;
  if (unit) return `${n} ${unit}`;
  return n;
}

export default function RangeSlider({
  title,
  unit,
  bounds,
  scale = "linear",
  step = 1,
  min,
  max,
  onMin,
  onMax,
  hint,
}: {
  title: string;
  unit?: string;
  /** Real min/max of the dataset (from facets.ranges). Absent → number-field fallback. */
  bounds?: { min?: number | null; max?: number | null };
  scale?: RangeScale;
  step?: number;
  min?: number;
  max?: number;
  onMin: (v?: number) => void;
  onMax: (v?: number) => void;
  hint?: string;
}) {
  const parse = (s: string) => (s === "" ? undefined : Number(s));

  const lo = typeof bounds?.min === "number" ? bounds.min : undefined;
  const hi = typeof bounds?.max === "number" ? bounds.max : undefined;
  const hasSlider = lo !== undefined && hi !== undefined && hi > lo;

  // ---- Fallback: no usable bounds → the original bare number-field pair. -----
  if (!hasSlider) {
    return (
      <div className="facet">
        <div className="facet-title">
          {title}
          {unit ? ` (${unit})` : ""}
        </div>
        <div className="range-fields">
          <input
            className="input"
            type="number"
            placeholder="min"
            value={min ?? ""}
            onChange={(e) => onMin(parse(e.target.value))}
            aria-label={`${title} minimum`}
          />
          <input
            className="input"
            type="number"
            placeholder="max"
            value={max ?? ""}
            onChange={(e) => onMax(parse(e.target.value))}
            aria-label={`${title} maximum`}
          />
        </div>
        {hint ? <div className="hint range-hint">{hint}</div> : null}
      </div>
    );
  }

  return (
    <SliderBody
      title={title}
      unit={unit}
      bounds={{ min: lo, max: hi }}
      scale={scale}
      step={step}
      min={min}
      max={max}
      onMin={onMin}
      onMax={onMax}
      hint={hint}
    />
  );
}

/** The real slider, split out so hooks only run once bounds are known. */
function SliderBody({
  title,
  unit,
  bounds,
  scale,
  step,
  min,
  max,
  onMin,
  onMax,
  hint,
}: {
  title: string;
  unit?: string;
  bounds: Bounds;
  scale: RangeScale;
  step: number;
  min?: number;
  max?: number;
  onMin: (v?: number) => void;
  onMax: (v?: number) => void;
  hint?: string;
}) {
  const model = buildModel(scale, bounds, step);
  const { sliderMin, sliderMax } = model;

  // Local handle positions in *slider units* (index for snap scales, value for
  // linear). Open sides sit on the domain edges. We keep them local so dragging
  // repaints instantly without refetching the grid on every tick — the parent is
  // only told on release.
  const [loPos, setLoPos] = useState(() =>
    min === undefined ? sliderMin : model.toPos(min),
  );
  const [hiPos, setHiPos] = useState(() =>
    max === undefined ? sliderMax : model.toPos(max),
  );
  const dragging = useRef(false);

  // Resync when the filter changes from the outside (reset, URL load) — but never
  // while the user is actively dragging, or we'd fight their hand.
  useEffect(() => {
    if (dragging.current) return;
    setLoPos(min === undefined ? sliderMin : model.toPos(min));
    setHiPos(max === undefined ? sliderMax : model.toPos(max));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [min, max, bounds.min, bounds.max, scale]);

  const span = sliderMax - sliderMin || 1;
  const leftPct = ((loPos - sliderMin) / span) * 100;
  const rightPct = ((sliderMax - hiPos) / span) * 100;

  // Commit local positions to the parent. A handle on the domain edge means
  // "unbounded" → emit undefined so a full selection reads as no filter.
  const commit = () => {
    onMin(loPos <= sliderMin ? undefined : model.toValue(loPos));
    onMax(hiPos >= sliderMax ? undefined : model.toValue(hiPos));
  };

  const onDragMin = (pos: number) => {
    dragging.current = true;
    setLoPos(Math.min(pos, hiPos));
  };
  const onDragMax = (pos: number) => {
    dragging.current = true;
    setHiPos(Math.max(pos, loPos));
  };
  const release = () => {
    dragging.current = false;
    commit();
  };

  // Number-field entry commits the raw value immediately (the precise escape
  // hatch); the handle just settles on the nearest position.
  const setMinField = (v?: number) => {
    onMin(v);
    setLoPos(v === undefined ? sliderMin : Math.min(model.toPos(v), hiPos));
  };
  const setMaxField = (v?: number) => {
    onMax(v);
    setHiPos(v === undefined ? sliderMax : Math.max(model.toPos(v), loPos));
  };
  const parse = (s: string) => (s === "" ? undefined : Number(s));

  const loVal = model.toValue(loPos);
  const hiVal = model.toValue(hiPos);
  // Keep the min thumb grabbable when both handles crowd the top end.
  const minOnTop = loPos > (sliderMin + sliderMax) / 2;

  return (
    <div className="facet">
      <div className="facet-title">
        {title}
        {unit ? ` (${unit})` : ""}
      </div>

      <div
        className="range-track-wrap"
        role="group"
        aria-label={`${title} range`}
      >
        <div className="range-track" />
        <div
          className="range-fill"
          style={{ left: `${leftPct}%`, right: `${rightPct}%` }}
        />
        <input
          type="range"
          className={cn("range-thumb", minOnTop && "range-thumb-top")}
          min={sliderMin}
          max={sliderMax}
          step={model.sliderStep}
          value={loPos}
          onChange={(e) => onDragMin(Number(e.target.value))}
          onPointerUp={release}
          onKeyUp={release}
          onBlur={release}
          aria-label={`${title} minimum`}
          aria-valuetext={defaultFormat(loVal, unit)}
        />
        <input
          type="range"
          className="range-thumb"
          min={sliderMin}
          max={sliderMax}
          step={model.sliderStep}
          value={hiPos}
          onChange={(e) => onDragMax(Number(e.target.value))}
          onPointerUp={release}
          onKeyUp={release}
          onBlur={release}
          aria-label={`${title} maximum`}
          aria-valuetext={defaultFormat(hiVal, unit)}
        />
      </div>

      <div className="range-fields">
        <input
          className="input"
          type="number"
          placeholder={defaultFormat(bounds.min, unit)}
          value={min ?? ""}
          onChange={(e) => setMinField(parse(e.target.value))}
          aria-label={`${title} minimum`}
        />
        <input
          className="input"
          type="number"
          placeholder={defaultFormat(bounds.max, unit)}
          value={max ?? ""}
          onChange={(e) => setMaxField(parse(e.target.value))}
          aria-label={`${title} maximum`}
        />
      </div>

      {hint ? <div className="hint range-hint">{hint}</div> : null}
    </div>
  );
}
