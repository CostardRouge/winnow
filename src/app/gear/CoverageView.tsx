"use client";

// Layout 4 — "Coverage": the kit plotted on a focal-length axis.
//
// One logarithmic millimetre scale, and every lens drawn where it actually
// works: a zoom as a bar across its range, a prime as a point. This is the only
// view that answers the question a photographer asks before buying anything —
// what does the bag already cover, and where is the hole. It is drawn from what
// the frames RECORDED (cf. lib/gearSpec.ts: the name wins where it states a
// range, the EXIF fills the rest), so a zoom always shot at one end shows the
// range it owns, not the range it was used at.
//
// The scale itself lives in model.ts (`focalAxis`), shared with Marks so the two
// charts place the same lens at the same spot.
import Link from "next/link";
import type { FocalAxis, Kit, KitBody, KitLens } from "./model";
import { focalAxis, num } from "./model";

type Axis = FocalAxis;

function LensLane({ lens, axis }: { lens: KitLens; axis: Axis }) {
  const { focalMin, focalMax, zoom } = lens.optics;
  const a = focalMin;
  const b = zoom && focalMax != null ? focalMax : focalMin;
  return (
    <Link href={lens.href} className="gear-cv-lane" title={lens.tip}>
      <span className="gear-cv-label">
        <span className="gear-cv-name">{lens.label}</span>
        {lens.spec && <span className="gear-cv-spec">{lens.spec}</span>}
      </span>
      <span className="gear-cv-track">
        {a == null || b == null ? (
          <span className="gear-cv-unknown">no focal length recorded</span>
        ) : b > a ? (
          <span
            className="gear-cv-range"
            style={{
              left: `${axis.at(a) * 100}%`,
              width: `${(axis.at(b) - axis.at(a)) * 100}%`,
              opacity: 0.4 + 0.6 * lens.share,
            }}
          />
        ) : (
          <span
            className="gear-cv-point"
            style={{ left: `${axis.at(a) * 100}%`, opacity: 0.4 + 0.6 * lens.share }}
          />
        )}
      </span>
      <span className="gear-cv-count">{num(lens.stats.count)}</span>
    </Link>
  );
}

function Body({ body, axis }: { body: KitBody; axis: Axis }) {
  return (
    <section className="gear-cv-body">
      <Link href={body.href} className="gear-cv-head" title={body.tip}>
        <span className="gear-cv-head-name">{body.label}</span>
        <span className="gear-cv-kind">{body.kindLabel}</span>
        <span className="gear-cv-head-count">
          {body.lenses.length > 0
            ? `${body.lenses.length} ${body.lenses.length === 1 ? "lens" : "lenses"}`
            : "fixed or unrecorded lens"}
        </span>
      </Link>
      {body.lenses.map((l) => (
        <LensLane key={l.key} lens={l} axis={axis} />
      ))}
    </section>
  );
}

export default function CoverageView({ kit }: { kit: Kit }) {
  if (!kit.focal) {
    return (
      <p className="hint">
        No lens here records a focal length, so there is nothing to plot — try
        another layout.
      </p>
    );
  }
  const axis = focalAxis(kit.focal);
  return (
    <div className="gear-coverage">
      {/* The millimetre grid, carried down behind every lane: a segment only
          means something against the focal lengths on either side of it. */}
      <div className="gear-cv-grid" aria-hidden="true">
        <span className="gear-cv-label" />
        <span className="gear-cv-track">
          {axis.ticks.map((t) => (
            <span key={t.mm} className="gear-axis-line" style={{ left: `${t.at * 100}%` }} />
          ))}
        </span>
        <span className="gear-cv-count" />
      </div>
      <div className="gear-cv-axis">
        <span className="gear-cv-label" />
        <span className="gear-cv-track">
          {axis.ticks.map((t) => (
            <span key={t.mm} className="gear-cv-tick" style={{ left: `${t.at * 100}%` }}>
              {t.mm}
            </span>
          ))}
        </span>
        <span className="gear-cv-count">mm</span>
      </div>
      {kit.bodies.map((b) => (
        <Body key={b.name} body={b} axis={axis} />
      ))}
    </div>
  );
}
