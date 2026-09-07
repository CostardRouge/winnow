"use client";

// Layout 8 — "Marks": the bag's optical footprint.
//
// Two axes a photographer already thinks in — focal length across, maximum
// aperture down — and one mark per lens, sized by how much it shot. A prime is
// a dot; a zoom is the capsule its range covers, drawn at the aperture it opens
// to. It is the only layout that shows a HABIT rather than an inventory: the
// crowd tells you where you actually work, and the empty corners tell you what
// the bag can't do.
//
// Built from positioned elements on percentage tracks rather than SVG, like the
// Timeline and Coverage lanes — so every mark stays a real link into the grid
// (an <a> inside an <svg> would cost the client-side navigation) and every
// colour keeps coming from a theme token.
import Link from "next/link";
import type { Kit, KitLens } from "./model";
import { focalAxis, num } from "./model";

/** Where an aperture ruler may put a label: the marked stops, not arbitrary
 *  numbers. f/1.2 and f/1.8 earn a place because real fast glass sits there. */
const STOPS = [1, 1.2, 1.4, 1.8, 2, 2.8, 4, 5.6, 8, 11, 16, 22];

/** Only the busiest lenses get their name written on the plot; the rest would
 *  turn the drawing into a word cloud. Everything is named on hover. */
const LABELLED = 6;

type Plot = {
  lens: KitLens;
  /** Left edge and width of the mark, as fractions of the plot, 0–1. */
  x1: number;
  x2: number;
  y: number;
  /** Mark diameter (a dot) or thickness (a capsule), in px. */
  d: number;
  zoom: boolean;
};

/** Stops run fast-at-the-top, so a lens' vertical place is how much light it
 *  gathers. Log base 2 because a stop IS a doubling. */
function apertureAxis(range: { min: number; max: number }) {
  const lo = Math.log2(Math.max(range.min, 0.5) / 1.18);
  const hi = Math.log2(Math.max(range.max, range.min * 1.5) * 1.18);
  const at = (f: number) => (Math.log2(Math.max(f, 0.5)) - lo) / (hi - lo);
  const ticks: { f: number; at: number }[] = [];
  for (const f of STOPS) {
    const y = at(f);
    if (y < 0 || y > 1) continue;
    if (ticks.length > 0 && y - ticks[ticks.length - 1].at < 0.07) continue;
    ticks.push({ f, at: y });
  }
  return { at, ticks };
}

/** Area, not radius, follows the count — a mark twice as wide would read as
 *  four times the work. Floored at 9px so the smallest lens is still a target. */
const size = (count: number) => Math.min(9 + Math.sqrt(count) / 9, 34);

export default function MarksView({ kit }: { kit: Kit }) {
  if (!kit.focal || !kit.aperture) {
    return (
      <p className="hint">
        Nothing here records both a focal length and an aperture, so there is no
        footprint to plot — try another layout.
      </p>
    );
  }

  const fx = focalAxis(kit.focal);
  const ay = apertureAxis(kit.aperture);

  const all = kit.bodies.flatMap((b) => b.lenses);
  const plots: Plot[] = [];
  for (const lens of all) {
    const { focalMin, focalMax, aperture, zoom } = lens.optics;
    if (focalMin == null || aperture == null) continue;
    const far = zoom && focalMax != null && focalMax > focalMin ? focalMax : focalMin;
    plots.push({
      lens,
      x1: fx.at(focalMin),
      x2: fx.at(far),
      y: ay.at(aperture),
      d: size(lens.stats.count),
      zoom: far > focalMin,
    });
  }
  const missing = all.length - plots.length;

  // Which marks get a written name: the busiest few, then a greedy pass that
  // drops a name rather than print it over one already placed (a 35mm and a
  // 40mm, both at f/1.2, land on top of each other otherwise).
  const named = [...plots]
    .sort((a, b) => b.lens.stats.count - a.lens.stats.count)
    .slice(0, LABELLED);
  const placed: { x: number; y: number }[] = [];
  const labels = named.filter((p) => {
    const x = (p.x1 + p.x2) / 2;
    if (placed.some((q) => Math.abs(q.y - p.y) < 0.09 && Math.abs(q.x - x) < 0.16)) {
      return false;
    }
    placed.push({ x, y: p.y });
    return true;
  });

  return (
    <div className="gear-marks">
      <div className="gear-mk-chart">
        <div className="gear-mk-stops" aria-hidden="true">
          {ay.ticks.map((t) => (
            <span key={t.f} className="gear-mk-stop" style={{ top: `${t.at * 100}%` }}>
              f/{t.f}
            </span>
          ))}
        </div>

        <div className="gear-mk-plot">
          {ay.ticks.map((t) => (
            <span
              key={`h${t.f}`}
              className="gear-mk-hline"
              style={{ top: `${t.at * 100}%` }}
              aria-hidden="true"
            />
          ))}
          {fx.ticks.map((t) => (
            <span
              key={`v${t.mm}`}
              className="gear-mk-vline"
              style={{ left: `${t.at * 100}%` }}
              aria-hidden="true"
            />
          ))}

          {plots.map((p) => (
            <Link
              key={p.lens.key}
              href={p.lens.href}
              className={`gear-mk-mark${p.zoom ? " is-zoom" : ""}`}
              title={`${p.lens.label}\n${p.lens.spec ?? ""}\n${num(p.lens.stats.count)} media\n${p.lens.tip}`}
              style={{
                left: `${p.x1 * 100}%`,
                width: p.zoom ? `${(p.x2 - p.x1) * 100}%` : `${p.d}px`,
                height: `${p.d}px`,
                top: `${p.y * 100}%`,
                marginTop: `${-p.d / 2}px`,
                marginLeft: p.zoom ? 0 : `${-p.d / 2}px`,
                minWidth: `${p.d}px`,
              }}
            >
              <span className="sr-only">
                {p.lens.label}, {num(p.lens.stats.count)} media
              </span>
            </Link>
          ))}

          {labels.map((p) => {
            const x = ((p.x1 + p.x2) / 2) * 100;
            // Near an edge the name would run off the plot, so it hangs from the
            // edge instead of straddling the mark.
            const anchor = x < 18 ? "0" : x > 82 ? "-100%" : "-50%";
            return (
              <span
                key={`l${p.lens.key}`}
                className="gear-mk-name"
                style={{
                  left: `${x}%`,
                  top: `${p.y * 100}%`,
                  marginTop: `${-p.d / 2 - 8}px`,
                  transform: `translate(${anchor}, -100%)`,
                }}
                aria-hidden="true"
              >
                {p.lens.label}
              </span>
            );
          })}
        </div>

        <span className="gear-mk-corner" aria-hidden="true" />
        <div className="gear-mk-mm" aria-hidden="true">
          {fx.ticks.map((t) => (
            <span key={t.mm} className="gear-mk-tickmm" style={{ left: `${t.at * 100}%` }}>
              {t.mm}
            </span>
          ))}
        </div>
      </div>

      <div className="gear-mk-legend">
        <span>
          <i style={{ width: 9, height: 9 }} />
          <i style={{ width: 20, height: 20 }} />
          area = media shot
        </span>
        <span>
          <i style={{ width: 34, height: 9, borderRadius: 999 }} />a zoom spans its range
        </span>
        <span className="gear-mk-axes">
          across: focal length in mm, logarithmic · down: fastest aperture
        </span>
      </div>
      {missing > 0 && (
        <p className="gear-mk-missing">
          {num(missing)} {missing === 1 ? "lens is" : "lenses are"} not plotted: their
          files record no focal length or no aperture.
        </p>
      )}
    </div>
  );
}
