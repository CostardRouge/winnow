"use client";

// The heatmap's matrix: places down, months across, one cell per crossing.
//
// This is the "when × where" question answered in ONE object rather than two
// linked panels — a timetable of the library. A place that recurs every August
// is a dotted line across the row; a place visited once is a single mark with
// years of nothing after it, which is exactly the reading a map cannot give.
//
// What it gives up is geography: two rows can be neighbours or nine thousand
// kilometres apart and the grid says nothing about it. That is why it is one
// reading among four and not the only one.
import { useMemo, useState } from "react";
import type { HeatPlaces } from "@/lib/heat";
import {
  maxOf,
  rung,
  rungVar,
  type HeatCell,
  type Measure,
} from "@/lib/heatScale";

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

export type MatrixSort = "volume" | "recent";

type Row = {
  key: string;
  id: number | null;
  name: string;
  /** Tint slot, or `null` for the rows that stand for a pile rather than a place. */
  tint: number | null;
  months: Map<string, HeatCell>;
  total: HeatCell;
  last: string;
};

export default function HeatMatrix({
  data,
  measure,
  sort,
  onSort,
  span,
  onSpan,
  tintIds,
}: {
  data: HeatPlaces;
  measure: Measure;
  sort: MatrixSort;
  onSort: (s: MatrixSort) => void;
  span: [string, string] | null;
  onSpan: (s: [string, string] | null) => void;
  /** The place ids that carry a tint, so a row's dot matches the tinted calendar. */
  tintIds: number[];
}) {
  const [hover, setHover] = useState<
    { x: number; y: number; head: string; body: string; sub: string } | null
  >(null);

  const rows: Row[] = useMemo(() => {
    const mk = (
      key: string,
      id: number | null,
      name: string,
      months: { ym: string; c: number; p: number; u: number }[],
      tint: number | null,
    ): Row => {
      const m = new Map<string, HeatCell>();
      let last = "";
      const total: HeatCell = { c: 0, p: 0, u: 0 };
      for (const x of months) {
        m.set(x.ym, { c: x.c, p: x.p, u: x.u });
        total.c += x.c; total.p += x.p; total.u += x.u;
        if (x.ym > last) last = x.ym;
      }
      return { key, id, name, tint, months: m, total, last };
    };

    const out = data.places.map((p) => {
      const slot = tintIds.indexOf(p.id);
      return mk(`p${p.id}`, p.id, p.name, p.months, slot >= 0 ? slot : null);
    });
    if (data.other) out.push(mk("other", null, "Elsewhere", data.other.months, null));
    if (data.untagged.c) out.push(mk("none", null, "No position", data.untagged.months, null));

    return out.sort((a, b) =>
      sort === "volume" ? b.total.c - a.total.c : b.last.localeCompare(a.last),
    );
  }, [data, sort, tintIds]);

  // Every month between the first and the last the data reaches, so a gap is
  // drawn as a gap rather than closed up — the holes are half the point.
  const months = useMemo(() => {
    let lo = "", hi = "";
    for (const r of rows) for (const ym of r.months.keys()) {
      if (!lo || ym < lo) lo = ym;
      if (!hi || ym > hi) hi = ym;
    }
    if (!lo) return [] as string[];
    const out: string[] = [];
    let [y, m] = lo.split("-").map(Number);
    const [hy, hm] = hi.split("-").map(Number);
    while (y < hy || (y === hy && m <= hm)) {
      out.push(`${y}-${String(m).padStart(2, "0")}`);
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
    return out;
  }, [rows]);

  const max = useMemo(() => {
    const all: HeatCell[] = [];
    for (const r of rows) all.push(...r.months.values());
    return maxOf(all, measure);
  }, [rows, measure]);

  const years = useMemo(() => {
    const seen = new Map<string, number>();
    for (const ym of months) {
      const y = ym.slice(0, 4);
      seen.set(y, (seen.get(y) ?? 0) + 1);
    }
    return [...seen.entries()];
  }, [months]);

  function show(el: HTMLElement, head: string, body: string, sub: string) {
    const r = el.getBoundingClientRect();
    setHover({ x: r.left + r.width / 2, y: r.top, head, body, sub });
  }

  const monthSpan = (ym: string): [string, string] => {
    const [y, m] = ym.split("-").map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return [`${ym}-01`, `${ym}-${String(last).padStart(2, "0")}`];
  };

  if (!months.length) return <p className="hint">Nothing to place yet.</p>;

  return (
    <div className="heat-gridwrap" onPointerLeave={() => setHover(null)}>
      <div className="heat-scroll">
        <div className="heat-matrix">
          <div className="heat-mhead">
            <span className="heat-mlab" />
            {years.map(([y, n]) => (
              <span key={y} className="heat-myear" style={{ width: n * 13 - 2 }}>
                {y}
              </span>
            ))}
          </div>
          {rows.map((r) => (
            <div className="heat-mrow" key={r.key}>
              <span className="heat-mlab" title={r.name}>
                <i
                  className="heat-mdot"
                  style={{
                    background:
                      r.tint === null
                        ? "var(--color-border-strong)"
                        : `var(--heat-place-${r.tint})`,
                  }}
                  aria-hidden
                />
                {r.name}
              </span>
              <span className="heat-mcells">
                {months.map((ym) => {
                  const cell = r.months.get(ym);
                  const on = !span || (monthSpan(ym)[0] >= span[0] && monthSpan(ym)[0] <= span[1]);
                  const rr = cell ? rung(measure.of(cell), max) : 0;
                  const label = `${r.name}, ${MONTHS[Number(ym.slice(5)) - 1]} ${ym.slice(0, 4)}`;
                  return (
                    <button
                      key={ym}
                      type="button"
                      className={`heat-mcell${on ? "" : " is-dim"}`}
                      style={{ background: rungVar(rr) }}
                      aria-label={`${label} — ${cell ? measure.say(cell) : "nothing"}`}
                      onPointerOver={(e) =>
                        show(
                          e.currentTarget,
                          label,
                          cell ? measure.say(cell) : "nothing that month",
                          cell ? `${cell.c.toLocaleString("en-US")} frames` : "",
                        )
                      }
                      onFocus={(e) =>
                        show(
                          e.currentTarget,
                          label,
                          cell ? measure.say(cell) : "nothing that month",
                          cell ? `${cell.c.toLocaleString("en-US")} frames` : "",
                        )
                      }
                      onBlur={() => setHover(null)}
                      onClick={() => {
                        const s = monthSpan(ym);
                        onSpan(span && span[0] === s[0] && span[1] === s[1] ? null : s);
                      }}
                    />
                  );
                })}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="heat-sortrow">
        <button
          type="button"
          className={`heat-chip${sort === "volume" ? " is-on" : ""}`}
          onClick={() => onSort("volume")}
        >
          By volume
        </button>
        <button
          type="button"
          className={`heat-chip${sort === "recent" ? " is-on" : ""}`}
          onClick={() => onSort("recent")}
        >
          By last seen
        </button>
      </div>

      {hover && (
        <div
          className="heat-card"
          role="presentation"
          style={{
            left: Math.min(Math.max(hover.x, 110), window.innerWidth - 110),
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
