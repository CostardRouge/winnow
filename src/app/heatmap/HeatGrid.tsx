"use client";

// The heatmap's calendar: one block per year, seven rows of weeks, drawn on the
// shared ramp. Two readings use it — "Both" (where it is brushable and drives
// the map) and "Tinted" (where each day wears its place's colour).
//
// ## Day cells, and why a week toggle exists
//
// A year at one cell per DAY is 7 × 53; six years stack to a screenful. A
// decade does not, so the granularity toggle collapses a year to a single row
// of 53 WEEK cells — the same grid, a different question ("which weeks of my
// life have media in them"). Both readings are honest; neither is a default
// that fits everyone's library, which is why it is a control and not a guess.
//
// ## Its own hover card, never `title`
//
// The native tooltip takes about a second to appear on the first cell, which is
// far too slow for a grid meant to be swept over — the same finding Atelier's
// DayHeatmap records. The card is fixed-positioned and pointer-transparent, so
// it is never clipped by the horizontal scroller and never interrupts a sweep.
import { useMemo, useRef, useState } from "react";
import type { HeatDay } from "@/lib/heat";
import {
  maxOf,
  rung,
  rungVar,
  type HeatCell,
  type Measure,
} from "@/lib/heatScale";

const CELL = 11;
const GAP = 2;
const DAY_MS = 86_400_000;
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const WEEKDAYS = ["Mon","","Wed","","Fri","","Sun"];

export type Granularity = "day" | "week";

const pad = (n: number) => String(n).padStart(2, "0");
const isoOf = (t: number) => {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
const prettyDate = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
};

type Hover = { x: number; y: number; head: string; body: string; sub: string };

export default function HeatGrid({
  days,
  measure,
  granularity,
  tint,
  tints,
  span,
  onSpan,
}: {
  days: HeatDay[];
  measure: Measure;
  granularity: Granularity;
  /** Draw each day's place as a stripe along the foot of the cell. */
  tint?: boolean;
  /** The places that carry a tint, busiest first. */
  tints?: { id: number; name: string }[];
  /** The brushed span `[fromIso, toIso]`, dimming everything outside it. */
  span?: [string, string] | null;
  /** Brushing is offered only when this is supplied. */
  onSpan?: (span: [string, string] | null) => void;
}) {
  const [hover, setHover] = useState<Hover | null>(null);
  const dragFrom = useRef<string | null>(null);

  const byDate = useMemo(() => new Map(days.map((d) => [d.d, d])), [days]);
  // place id → tint slot; anything not in the list reads as "elsewhere".
  const slotOf = useMemo(
    () => new Map((tints ?? []).map((t, i) => [t.id, i])),
    [tints],
  );
  const nameOf = useMemo(
    () => new Map((tints ?? []).map((t) => [t.id, t.name])),
    [tints],
  );
  const years = useMemo(() => {
    const set = new Set(days.map((d) => Number(d.d.slice(0, 4))));
    return [...set].sort((a, b) => a - b);
  }, [days]);

  // The ramp's top is read over EVERY day, not the brushed subset: a cell that
  // changes colour because something else was selected is a cell nobody can
  // compare across two views.
  const dayMax = useMemo(() => maxOf(days, measure), [days, measure]);

  const weeks = useMemo(() => {
    if (granularity !== "week") return null;
    const m = new Map<string, HeatCell & { first: string; last: string }>();
    for (const d of days) {
      const y = Number(d.d.slice(0, 4));
      const w = Math.floor((Date.parse(d.d) - Date.UTC(y, 0, 1)) / DAY_MS / 7);
      const k = `${y}|${w}`;
      const cur = m.get(k);
      if (!cur) m.set(k, { c: d.c, p: d.p, u: d.u, first: d.d, last: d.d });
      else {
        cur.c += d.c; cur.p += d.p; cur.u += d.u;
        if (d.d < cur.first) cur.first = d.d;
        if (d.d > cur.last) cur.last = d.d;
      }
    }
    return m;
  }, [days, granularity]);

  const weekMax = useMemo(
    () => (weeks ? maxOf(weeks.values(), measure) : 0),
    [weeks, measure],
  );

  const inSpan = (iso: string) => !span || (iso >= span[0] && iso <= span[1]);

  function show(el: HTMLElement, head: string, body: string, sub: string) {
    const r = el.getBoundingClientRect();
    setHover({ x: r.left + r.width / 2, y: r.top, head, body, sub });
  }

  // A press-drag across day cells sets the span; a plain click picks one day.
  const brushing = Boolean(onSpan) && granularity === "day";
  const cellPointerDown = (iso: string) => {
    if (!brushing) return;
    dragFrom.current = iso;
  };
  const cellPointerOver = (iso: string) => {
    if (!brushing || !dragFrom.current) return;
    const a = dragFrom.current;
    onSpan!(a <= iso ? [a, iso] : [iso, a]);
  };
  const cellClick = (iso: string) => {
    if (!brushing) return;
    // A click that did not drag toggles that single day.
    if (dragFrom.current === iso) {
      onSpan!(span && span[0] === iso && span[1] === iso ? null : [iso, iso]);
    }
    dragFrom.current = null;
  };

  return (
    <div
      className="heat-gridwrap"
      onPointerUp={() => { dragFrom.current = null; }}
      onPointerLeave={() => setHover(null)}
    >
      <div className="heat-scroll">
        <div className="heat-years">
          {years.map((y) => {
            const jan1 = Date.UTC(y, 0, 1);
            const lead = (new Date(jan1).getUTCDay() + 6) % 7; // Monday-first
            return (
              <div className="heat-yearblock" key={y}>
                <span className="heat-ylabel">{y}</span>
                {granularity === "day" && (
                  <div className="heat-wdays" aria-hidden>
                    {WEEKDAYS.map((w, i) => (
                      <span key={i} style={{ height: CELL }}>{w}</span>
                    ))}
                  </div>
                )}
                <div
                  className="heat-cells"
                  role="grid"
                  aria-label={`${y}, ${measure.label}`}
                  style={{
                    gap: GAP,
                    gridTemplateRows:
                      granularity === "day" ? `repeat(7, ${CELL}px)` : `${CELL}px`,
                  }}
                >
                  {granularity === "day"
                    ? Array.from({ length: 371 }, (_, i) => {
                        const t = jan1 + (i - lead) * DAY_MS;
                        const iso = isoOf(t);
                        if (Number(iso.slice(0, 4)) !== y) {
                          return <span key={i} className="heat-cell is-void" />;
                        }
                        const row = byDate.get(iso);
                        const on = inSpan(iso);
                        const cell: HeatCell = row ?? { c: 0, p: 0, u: 0 };
                        const r = row ? rung(measure.of(cell), dayMax) : 0;
                        const slot = row?.pl != null ? slotOf.get(row.pl) : undefined;
                        const place =
                          row?.pl == null
                            ? "no position"
                            : (nameOf.get(row.pl) ?? "elsewhere");
                        return (
                          <button
                            key={i}
                            type="button"
                            role="gridcell"
                            className={`heat-cell${on ? "" : " is-dim"}${
                              span && span[0] === iso && span[1] === iso ? " is-picked" : ""
                            }`}
                            style={{
                              background: rungVar(r),
                              boxShadow:
                                tint && slot !== undefined
                                  ? `inset 0 -3px 0 0 var(--heat-place-${slot})`
                                  : undefined,
                            }}
                            aria-label={`${prettyDate(iso)} — ${measure.say(cell)}`}
                            onPointerDown={() => cellPointerDown(iso)}
                            onPointerOver={(e) => {
                              cellPointerOver(iso);
                              show(
                                e.currentTarget,
                                prettyDate(iso),
                                row ? measure.say(cell) : "nothing that day",
                                row ? `${cell.c.toLocaleString("en-GB")} frames · ${place}` : "",
                              );
                            }}
                            onFocus={(e) =>
                              show(
                                e.currentTarget,
                                prettyDate(iso),
                                row ? measure.say(cell) : "nothing that day",
                                row ? `${cell.c.toLocaleString("en-GB")} frames · ${place}` : "",
                              )
                            }
                            onBlur={() => setHover(null)}
                            onClick={() => cellClick(iso)}
                          />
                        );
                      })
                    : Array.from({ length: 53 }, (_, w) => {
                        const agg = weeks?.get(`${y}|${w}`);
                        const r = agg ? rung(measure.of(agg), weekMax) : 0;
                        return (
                          <button
                            key={w}
                            type="button"
                            role="gridcell"
                            className="heat-cell"
                            style={{ background: rungVar(r) }}
                            aria-label={
                              agg
                                ? `${prettyDate(agg.first)} to ${prettyDate(agg.last)} — ${measure.say(agg)}`
                                : `week ${w + 1} of ${y} — nothing`
                            }
                            onPointerOver={(e) =>
                              show(
                                e.currentTarget,
                                agg ? `${prettyDate(agg.first)} → ${prettyDate(agg.last)}` : `Week ${w + 1}, ${y}`,
                                agg ? measure.say(agg) : "nothing that week",
                                agg ? `${agg.c.toLocaleString("en-GB")} frames` : "",
                              )
                            }
                            onFocus={(e) =>
                              show(
                                e.currentTarget,
                                agg ? `${prettyDate(agg.first)} → ${prettyDate(agg.last)}` : `Week ${w + 1}, ${y}`,
                                agg ? measure.say(agg) : "nothing that week",
                                agg ? `${agg.c.toLocaleString("en-GB")} frames` : "",
                              )
                            }
                            onBlur={() => setHover(null)}
                            onClick={() => {
                              if (!onSpan || !agg) return;
                              onSpan(
                                span && span[0] === agg.first && span[1] === agg.last
                                  ? null
                                  : [agg.first, agg.last],
                              );
                            }}
                          />
                        );
                      })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {hover && (
        <div
          className="heat-card"
          role="presentation"
          style={{
            left: Math.min(Math.max(hover.x, 100), window.innerWidth - 100),
            top: hover.y - 10,
          }}
        >
          <span className="heat-card-h">{hover.head}</span>
          <span className="heat-card-b">{hover.body}</span>
          {hover.sub && <span className="heat-card-s">{hover.sub}</span>}
        </div>
      )}
    </div>
  );
}

/** Roll days up into a month bucket — the ribbon and the year rail share it. */
export function byMonth(days: HeatDay[]): Map<string, HeatCell> {
  const m = new Map<string, HeatCell>();
  for (const d of days) {
    const ym = d.d.slice(0, 7);
    const cur = m.get(ym);
    if (cur) { cur.c += d.c; cur.p += d.p; cur.u += d.u; }
    else m.set(ym, { c: d.c, p: d.p, u: d.u });
  }
  return m;
}
