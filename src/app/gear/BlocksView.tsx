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
 * A row's height floor, in PIXELS — the two-line label (name over count) plus
 * its padding, and the smallest tile that can still be read.
 *
 * It was a *fraction* of the drawing at first, which held for a five-body kit
 * and quietly failed for a real one: with twelve bodies the floors share the
 * same fixed height, so every one of them shrinks, and the tail rendered at 29px
 * with its label cut through the middle. A floor that scales with the number of
 * rows is not a floor.
 */
const MIN_ROW_PX = 46;

/**
 * The pixels handed out BY SHARE on top of that floor, so the drawing still
 * says "this body shot most of the library" once every row is legible. The
 * container's height is therefore `rows × MIN_ROW_PX + SCALE_PX` rather than a
 * constant: a kit with more bodies gets a taller surface, not thinner rows.
 *
 * The floor is a declared distortion — the areas below it are no longer to
 * scale. That is the honest trade for a tile you can actually read, and it is
 * why the row keeps printing its own count.
 */
const SCALE_PX = 420;

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
  // Heights in pixels rather than flex weights: proportional flex needs a
  // definite container height to divide, and any constant we picked for it was
  // a guess about how many bodies a library has.
  const height = (b: (typeof kit.bodies)[number]) =>
    MIN_ROW_PX +
    (kit.totalFrames > 0 ? b.stats.count / kit.totalFrames : 0) * SCALE_PX;

  return (
    <div className="gear-blocks">
      {kit.bodies.map((b) => (
        <div key={b.name} className="gear-blk-row" style={{ height: height(b) }}>
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
