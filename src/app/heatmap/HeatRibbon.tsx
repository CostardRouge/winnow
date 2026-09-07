"use client";

// The month scrubber under the map-first reading: one bar per month across the
// whole library, brushed like a video timeline.
//
// Height AND colour carry the measure. That is doubled encoding on purpose —
// the bar is 11 px wide, and at that size a rung alone is hard to compare
// across a decade, while height alone loses the "how hot is this" reading the
// rest of the screen is drawn on.
import { useMemo, useState } from "react";
import {
  maxOf,
  rung,
  rungVar,
  type HeatCell,
  type Measure,
} from "@/lib/heatScale";

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const H = 46;

export default function HeatRibbon({
  months,
  measure,
  span,
  onSpan,
}: {
  /** Month key (`YYYY-MM`) → tallies, in ascending key order. */
  months: Map<string, HeatCell>;
  measure: Measure;
  span: [string, string] | null;
  onSpan: (s: [string, string] | null) => void;
}) {
  const [hover, setHover] = useState<
    { x: number; y: number; head: string; body: string; sub: string } | null
  >(null);

  // Fill the gaps: a month with nothing in it is drawn empty, never skipped.
  const keys = useMemo(() => {
    const all = [...months.keys()].sort();
    if (!all.length) return [] as string[];
    const out: string[] = [];
    let [y, m] = all[0].split("-").map(Number);
    const [hy, hm] = all[all.length - 1].split("-").map(Number);
    while (y < hy || (y === hy && m <= hm)) {
      out.push(`${y}-${String(m).padStart(2, "0")}`);
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
    return out;
  }, [months]);

  const max = useMemo(() => maxOf(months.values(), measure), [months, measure]);

  const monthSpan = (ym: string): [string, string] => {
    const [y, m] = ym.split("-").map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return [`${ym}-01`, `${ym}-${String(last).padStart(2, "0")}`];
  };

  if (!keys.length) return null;

  return (
    <div className="heat-gridwrap" onPointerLeave={() => setHover(null)}>
      <div className="heat-scroll">
        <div className="heat-ribbon" role="group" aria-label={`Months by ${measure.label.toLowerCase()}`}>
          {keys.map((ym) => {
            const cell = months.get(ym);
            const v = cell ? measure.of(cell) : 0;
            const r = cell ? rung(v, max) : 0;
            const h = max > 0 && v !== null ? Math.max(3, Math.round(H * (v / max))) : 3;
            const s = monthSpan(ym);
            const on = !span || (s[0] >= span[0] && s[0] <= span[1]);
            const label = `${MONTHS[Number(ym.slice(5)) - 1]} ${ym.slice(0, 4)}`;
            return (
              <button
                key={ym}
                type="button"
                className={`heat-rbar${on ? "" : " is-dim"}`}
                style={{ height: h, background: rungVar(r) }}
                aria-label={`${label} — ${cell ? measure.say(cell) : "nothing"}`}
                onPointerOver={(e) => {
                  const b = e.currentTarget.getBoundingClientRect();
                  setHover({
                    x: b.left + b.width / 2,
                    y: b.top,
                    head: label,
                    body: cell ? measure.say(cell) : "nothing that month",
                    sub: cell ? `${cell.c.toLocaleString("en-GB")} frames` : "",
                  });
                }}
                onBlur={() => setHover(null)}
                onClick={() =>
                  onSpan(span && span[0] === s[0] && span[1] === s[1] ? null : s)
                }
              />
            );
          })}
        </div>
        <div className="heat-rticks" aria-hidden>
          {keys.map((ym) => (
            <span key={ym}>{ym.endsWith("-01") ? ym.slice(0, 4) : ""}</span>
          ))}
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
