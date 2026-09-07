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
 * A row's height floor, as a fraction of the drawing. Without it a drone with
 * 640 frames next to a body with 15,000 is a 12-pixel sliver whose label can't
 * be drawn — and a tile you cannot read says nothing at all. The floor is
 * declared, not hidden: the areas below it are no longer to scale, which is the
 * honest trade for keeping every body visible.
 */
const MIN_ROW = 0.115;

/** Below this share of its row, a tile can't hold its name — hover carries it. */
const LABEL_AT = 0.11;

/**
 * `tone` is the tile's share of the WHOLE library, not of its row — unlike
 * Stack, where each bar is its own 100 %. Here area already means "media", and
 * a per-row tone would paint the drone's single lens-less tile (100 % of a tiny
 * row) darker than the 6,000-frame zoom above it: the smallest thing on the
 * page as the heaviest. One scale across every tile keeps ink and area agreeing.
 */
function Tile({ part, tone }: { part: KitPart; tone: number }) {
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
        <small>{num(part.count)}</small>
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
  const floors = kit.bodies.map((b) =>
    Math.max(kit.totalFrames > 0 ? b.stats.count / kit.totalFrames : 0, MIN_ROW),
  );
  const sum = floors.reduce((a, v) => a + v, 0) || 1;

  return (
    <div className="gear-blocks">
      {kit.bodies.map((b, i) => (
        <div key={b.name} className="gear-blk-row" style={{ flexGrow: floors[i] / sum }}>
          <Link href={b.href} className="gear-blk-label" title={`${b.kindLabel}\n${b.tip}`}>
            <b>{b.label}</b>
            <small>{num(b.stats.count)} media</small>
          </Link>
          {b.parts.map((p) => (
            <Tile
              key={p.key}
              part={p}
              tone={kit.totalFrames > 0 ? p.count / kit.totalFrames : 0}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
