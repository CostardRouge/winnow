"use client";

// Layout 3 — "Timeline": the kit as a service record.
//
// Every body and every lens gets a bar spanning from its first indexed frame to
// its last, all on one shared year axis. Nothing else on /gear shows this: the
// counts say how much a piece worked, only the axis says *when* — which body
// replaced which, the year the fast prime lived on the camera, the lens bought
// last spring, the one that has not come out since 2021. The span is read off
// the library, so a piece owned but unused simply is not here.
import Link from "next/link";
import type { Kit, KitBody, KitLens } from "./model";
import { num } from "./model";

/** Whole-year bounds around the kit's span: bars then sit inside their axis and
 *  the ticks land on January 1st instead of on an arbitrary first shutter. */
function axisFor(span: { from: number; to: number }) {
  const first = new Date(span.from).getFullYear();
  const last = new Date(span.to).getFullYear();
  const from = new Date(first, 0, 1).getTime();
  // Exclusive upper bound — the first instant of the year AFTER the last one,
  // so a bar ending in December reaches the right edge rather than stopping a
  // year short.
  const to = new Date(last + 1, 0, 1).getTime();
  // At most a dozen labels: a fifteen-year library would otherwise pack them
  // into an unreadable ruler on a phone.
  const years = last - first + 1;
  const step = years <= 12 ? 1 : years <= 24 ? 2 : Math.ceil(years / 12);
  const ticks: { year: number; at: number }[] = [];
  for (let y = first; y <= last; y += step) {
    ticks.push({ year: y, at: (new Date(y, 0, 1).getTime() - from) / (to - from) });
  }
  return { from, to, ticks };
}

/** A bar, positioned as percentages of the shared axis. CSS gives it a floor
 *  width so a single day of use still leaves a mark. */
function pos(axis: { from: number; to: number }, a: number, b: number) {
  const total = axis.to - axis.from;
  const left = ((a - axis.from) / total) * 100;
  const width = ((b - a) / total) * 100;
  return { left: `${Math.max(left, 0)}%`, width: `${Math.max(width, 0)}%` };
}

type Axis = ReturnType<typeof axisFor>;

function Lane({
  axis,
  href,
  title,
  name,
  spec,
  count,
  from,
  to,
  share,
  kind,
}: {
  axis: Axis;
  href: string;
  title: string;
  name: string;
  spec: string | null;
  count: string;
  from: number | null;
  to: number | null;
  /** 0–1: darkens the bar, so the busiest gear reads first on a crowded axis. */
  share: number;
  kind: "body" | "lens";
}) {
  return (
    <Link href={href} className={`gear-tl-lane is-${kind}`} title={title}>
      <span className="gear-tl-label">
        <span className="gear-tl-name">{name}</span>
        {spec && <span className="gear-tl-spec">{spec}</span>}
      </span>
      <span className="gear-tl-track">
        {from == null || to == null ? (
          <span className="gear-tl-undated">no capture dates</span>
        ) : (
          <span
            className="gear-tl-bar"
            style={{ ...pos(axis, from, to), opacity: 0.35 + 0.65 * share }}
          />
        )}
      </span>
      <span className="gear-tl-count">{count}</span>
    </Link>
  );
}

function Body({ body, axis }: { body: KitBody; axis: Axis }) {
  return (
    <section className="gear-tl-body">
      <Lane
        axis={axis}
        href={body.href}
        title={body.tip}
        name={body.label}
        spec={body.kindLabel}
        count={num(body.stats.count)}
        from={body.from}
        to={body.to}
        share={body.share}
        kind="body"
      />
      {body.lenses.map((l: KitLens) => (
        <Lane
          key={l.key}
          axis={axis}
          href={l.href}
          title={l.tip}
          name={l.label}
          spec={l.spec}
          count={num(l.stats.count)}
          from={l.from}
          to={l.to}
          share={l.share}
          kind="lens"
        />
      ))}
    </section>
  );
}

export default function TimelineView({ kit }: { kit: Kit }) {
  if (!kit.span) {
    return (
      <p className="hint">
        Nothing here carries a capture date, so there is no timeline to draw — try
        another layout.
      </p>
    );
  }
  const axis = axisFor(kit.span);
  return (
    <div className="gear-timeline">
      {/* The years, carried the full height of the list behind the bars: a bar
          floating on an empty band can be read against its neighbours but not
          against a date, which is the whole point of this layout. */}
      <div className="gear-tl-grid" aria-hidden="true">
        <span className="gear-tl-label" />
        <span className="gear-tl-track">
          {axis.ticks.map((t) => (
            <span key={t.year} className="gear-axis-line" style={{ left: `${t.at * 100}%` }} />
          ))}
        </span>
        <span className="gear-tl-count" />
      </div>
      {/* The ruler is sticky: a long kit scrolls past it, and a gridline means
          nothing once its year has scrolled away. */}
      <div className="gear-tl-axis">
        <span className="gear-tl-label" />
        <span className="gear-tl-track">
          {axis.ticks.map((t) => (
            <span key={t.year} className="gear-tl-tick" style={{ left: `${t.at * 100}%` }}>
              {t.year}
            </span>
          ))}
        </span>
        <span className="gear-tl-count" />
      </div>
      {kit.bodies.map((b) => (
        <Body key={b.name} body={b} axis={axis} />
      ))}
    </div>
  );
}
