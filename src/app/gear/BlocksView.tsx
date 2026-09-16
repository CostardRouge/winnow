"use client";

// Layout 6 — "Blocks": the whole kit as one surface.
//
// Every area is proportional to a number of frames: a row per body, sliced into
// a tile per lens. Where Stack normalises each body to its own 100 %, this one
// keeps every body on the SAME scale — so a row's height is how much that body
// worked against all the others, and the eye gets the kit's hierarchy without
// reading a single figure.
//
// Slice-and-dice rather than a squarified treemap: the rows are the bodies, and
// a body is the grouping the whole shelf is built on (cf. GearPanel). Squarifying
// would give prettier aspect ratios and lose the one axis that means something.
import Link from "next/link";
import type { Kit, KitPart } from "./model";
import { num, shareInk, shareInkText } from "./model";

/**
 * A row's height floor, in PIXELS — the unit the text is actually drawn in. A
 * floor expressed as a fraction of the drawing buys nothing once the drawing
 * has a fixed height: seventeen bodies divide it into ~30 px rows whatever the
 * fraction says, because the fraction is relative to a total that grows with
 * them, and every label is then cut through the middle. So the row heights are
 * computed here and the surface is as tall as they come to — it grows with the
 * kit, the way Stack's one-bar-per-body already does.
 *
 * The areas below the floor are no longer to scale; that is declared, not
 * hidden, and is the honest trade for keeping every body visible and legible.
 */
const ROW_FLOOR = 30;

/**
 * What is shared out proportionally ON TOP of every row's floor. The hierarchy
 * lives in this budget alone, so it stays readable however many bodies there
 * are: each row is `ROW_FLOOR + share × BUDGET`, and the drawing is as tall as
 * that comes to.
 */
const BUDGET = 420;

/** Under this height a row holds one line, not two — the count moves to the tip. */
const TWO_LINES_AT = 42;

/** Below this share of its row, a tile can't hold its name — hover carries it. */
const LABEL_AT = 0.11;

/**
 * `tone` is the tile's share of the WHOLE library, not of its row — unlike
 * Stack, where each bar is its own 100 %. Here area already means "media", and
 * a per-row tone would paint the drone's single lens-less tile (100 % of a tiny
 * row) darker than the 6,000-frame zoom above it: the smallest thing on the
 * page as the heaviest. One scale across every tile keeps ink and area agreeing.
 */
function Tile({ part, tone, twoLines }: { part: KitPart; tone: number; twoLines: boolean }) {
  const style = {
    flexGrow: part.count,
    background: shareInk(tone),
    color: shareInkText(tone),
  };
  const tip = `${part.label} — ${num(part.count)}\n${part.tip}`;
  const inner =
    part.share >= LABEL_AT ? (
      <>
        <b>{part.label}</b>
        {twoLines ? <small>{num(part.count)}</small> : null}
      </>
    ) : null;
  return part.href ? (
    <Link href={part.href} className="gear-blk-tile" style={style} title={tip}>
      {inner}
    </Link>
  ) : (
    <span className="gear-blk-tile" style={style} title={tip}>
      {inner}
    </span>
  );
}

export default function BlocksView({ kit }: { kit: Kit }) {
  const heights = kit.bodies.map(
    (b) => ROW_FLOOR + (kit.totalFrames > 0 ? b.stats.count / kit.totalFrames : 0) * BUDGET,
  );

  return (
    <div className="gear-blocks">
      {kit.bodies.map((b, i) => {
        const twoLines = heights[i] >= TWO_LINES_AT;
        const tip = `${b.kindLabel}\n${num(b.stats.count)} media\n${b.tip}`;
        return (
          <div key={b.name} className="gear-blk-row" style={{ height: `${heights[i]}px` }}>
            <Link href={b.href} className="gear-blk-label" title={tip}>
              <b>{b.label}</b>
              {twoLines ? <small>{num(b.stats.count)} media</small> : null}
            </Link>
            {b.parts.map((p) => (
              <Tile
                key={p.key}
                part={p}
                tone={kit.totalFrames > 0 ? p.count / kit.totalFrames : 0}
                twoLines={twoLines}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}
