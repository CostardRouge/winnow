"use client";

// Layout 5 — "Stack": where the frames actually went.
//
// The default layout, and the only one that leads with a PROPORTION rather than
// a number. One bar for the whole library split by body, then one bar per body
// split by the glass that rode on it — so "the 24-70 is half of everything I
// shoot" is a shape, not an arithmetic exercise across five rows of counts.
//
// Each bar sums to its own total, untagged frames included (cf. KitPart): a
// part-to-whole picture that quietly drops the remainder is a picture that
// lies. The segments carry the links; the legend under each bar carries the
// identity, because a 2 % sliver is a shape you can see and a name you cannot.
import Link from "next/link";
import type { Kit, KitBody, KitPart } from "./model";
import { num, shareInk, shareInkText } from "./model";

/** Below this, a segment is too narrow to hold even "34%" without clipping. */
const LABEL_AT = 0.11;

function Bar({ parts, label }: { parts: KitPart[]; label: string }) {
  return (
    <div className="gear-stk-bar" role="img" aria-label={label}>
      {parts.map((p) => {
        const style = { flexGrow: p.count, background: shareInk(p.share) };
        const inner = (
          <span className="gear-stk-pct" style={{ color: shareInkText(p.share) }}>
            {p.share >= LABEL_AT ? `${Math.round(p.share * 100)}%` : ""}
          </span>
        );
        const tip = `${p.label} — ${num(p.count)} (${Math.round(p.share * 100)}%)\n${p.tip}`;
        // The untagged remainder has no grid to open, so it is a span; every
        // other segment is the same shortcut the rest of the shelf offers.
        return p.href ? (
          <Link key={p.key} href={p.href} className="gear-stk-seg" style={style} title={tip}>
            {inner}
          </Link>
        ) : (
          <span key={p.key} className="gear-stk-seg" style={style} title={tip}>
            {inner}
          </span>
        );
      })}
    </div>
  );
}

function Legend({ parts }: { parts: KitPart[] }) {
  return (
    <div className="gear-stk-legend">
      {parts.map((p) => {
        const swatch = (
          <>
            <i style={{ background: shareInk(p.share) }} aria-hidden="true" />
            {p.label}
            <b>{num(p.count)}</b>
          </>
        );
        return p.href ? (
          <Link key={p.key} href={p.href} className="gear-stk-key" title={p.tip}>
            {swatch}
          </Link>
        ) : (
          <span key={p.key} className="gear-stk-key is-flat" title={p.tip}>
            {swatch}
          </span>
        );
      })}
    </div>
  );
}

function Body({ body }: { body: KitBody }) {
  return (
    <section className="gear-stk-body">
      <div className="gear-stk-head">
        <Link href={body.href} className="gear-stk-name" title={body.tip}>
          {body.label}
        </Link>
        <span className="gear-stk-kind">{body.kindLabel}</span>
        {body.years && <span className="gear-stk-years">{body.years}</span>}
        <span className="gear-stk-total">{num(body.stats.count)}</span>
      </div>
      <Bar parts={body.parts} label={`${body.label}: frames by lens`} />
      <Legend parts={body.parts} />
    </section>
  );
}

export default function StackView({ kit }: { kit: Kit }) {
  // A body with no lens rows at all (a drone, a phone whose files name no lens)
  // would draw a full-width bar with one segment saying "No lens recorded" —
  // a shape carrying no information. They get a line instead, still linked.
  const split = kit.bodies.filter((b) => b.lenses.length > 0);
  const whole = kit.bodies.filter((b) => b.lenses.length === 0);

  const libraryParts: KitPart[] = kit.bodies.map((b) => ({
    key: b.name,
    label: b.label,
    count: b.stats.count,
    share: kit.totalFrames > 0 ? b.stats.count / kit.totalFrames : 0,
    href: b.href,
    tip: b.tip,
  }));

  return (
    <div className="gear-stack">
      {/* One body is its own whole library; the bar would say nothing twice. */}
      {kit.bodies.length > 1 && (
        <section className="gear-stk-body">
          <h3 className="gear-stk-lead">The whole library, by body</h3>
          <Bar parts={libraryParts} label="Frames by camera body" />
          <Legend parts={libraryParts} />
        </section>
      )}

      {split.map((b) => (
        <Body key={b.name} body={b} />
      ))}

      {whole.length > 0 && (
        <section className="gear-stk-body">
          <h3 className="gear-stk-lead">Fixed or unrecorded lens</h3>
          <div className="gear-stk-flat">
            {whole.map((b) => {
              // Same denominator as the library bar above, so a body's swatch
              // is the same ink here as it is up there.
              const s = kit.totalFrames > 0 ? b.stats.count / kit.totalFrames : 0;
              return (
                <Link key={b.name} href={b.href} className="gear-stk-key" title={b.tip}>
                  <i style={{ background: shareInk(s) }} aria-hidden="true" />
                  {b.label}
                  <b>{num(b.stats.count)}</b>
                </Link>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
