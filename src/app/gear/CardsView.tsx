"use client";

// Layout 2 — "Cards": one card per body, and the number is the hero.
//
// Where the Index reads down a column, this one reads at a glance: the card is
// mostly a very large tally set in mono, with the body's name under it and its
// glass listed inside the same card. That inversion — figure first, name second
// — is what replaces the illustration the page used to lead with: the thing
// worth looking at from across the room is how much a body actually shot, not a
// drawing of it.
import Link from "next/link";
import type { Kit, KitBody } from "./model";
import { countParts, num } from "./model";

function Card({ body }: { body: KitBody }) {
  const { n, unit } = countParts(body.stats);
  const meta = [body.shutter, body.split, body.elsewhere].filter(Boolean) as string[];
  return (
    <article className="gear-plate">
      <header className="gear-plate-head">
        <span className="gear-plate-kind">{body.kindLabel}</span>
        {body.years && <span className="gear-plate-years">{body.years}</span>}
      </header>

      <Link href={body.href} className="gear-plate-figure" title={body.tip}>
        <span className="gear-plate-n">{n}</span>
        <span className="gear-plate-unit">{unit}</span>
        <span className="gear-plate-name">{body.label}</span>
      </Link>

      {meta.length > 0 && (
        <p className="gear-plate-meta">
          {meta.map((m) => (
            <span key={m}>{m}</span>
          ))}
        </p>
      )}

      <div className="gear-plate-glass">
        <h3 className="gear-plate-glass-head">
          {body.lenses.length > 0
            ? `${body.lenses.length} ${body.lenses.length === 1 ? "lens" : "lenses"}`
            : "No lens recorded"}
        </h3>
        {/* Name and count only: a card is narrow, and the spec is one hover (or
            one switch to the Index) away. The name usually states it anyway. */}
        {body.lenses.map((l) => (
          <Link key={l.key} href={l.href} className="gear-plate-lens" title={l.tip}>
            {/* The share bar is the row's own background rather than a column
                of its own — the busiest glass reads first without stealing
                width from the name. */}
            <span
              className="gear-plate-lens-fill"
              style={{ width: `${Math.max(l.share * 100, 4)}%` }}
              aria-hidden="true"
            />
            <span className="gear-plate-lens-name">{l.label}</span>
            <span className="gear-plate-lens-count">{num(l.stats.count)}</span>
          </Link>
        ))}
        {/* On a body with no lens rows at all the heading above already said it;
            saying it twice reads like a bug. */}
        {body.untagged > 0 && body.lenses.length > 0 && (
          <span className="gear-plate-untagged">
            {num(body.untagged)} {body.untagged === 1 ? "frame" : "frames"} without a lens
            tag
          </span>
        )}
      </div>
    </article>
  );
}

export default function CardsView({ kit }: { kit: Kit }) {
  return (
    <div className="gear-plates">
      {kit.bodies.map((b) => (
        <Card key={b.name} body={b} />
      ))}
    </div>
  );
}
