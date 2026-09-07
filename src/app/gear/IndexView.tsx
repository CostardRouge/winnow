"use client";

// Layout 1 — "Index": the kit as a printed inventory sheet.
//
// One aligned grid across the whole page: every lens, whatever body it hangs
// off, puts its spec, its usage meter, its years and its count in the same four
// columns, so a kit reads down a column instead of card by card. Bodies are the
// section heads of that sheet, not cards of their own — which is the point of
// this layout: it answers "what do I own and how much did each piece work"
// without a single picture, and it is the densest of the four.
import Link from "next/link";
import type { Kit, KitBody, KitLens } from "./model";
import { countLabel, countParts, num } from "./model";

/** Share of its body's frames, drawn as a bar. Purely relative — the number is
 *  right there in the next column, this is only for the eye scanning down. */
function Meter({ share, title }: { share: number; title: string }) {
  return (
    <span className="gear-meter" title={title} aria-hidden="true">
      <span className="gear-meter-fill" style={{ width: `${Math.max(share * 100, 1.5)}%` }} />
    </span>
  );
}

function LensRow({ lens }: { lens: KitLens }) {
  const { n, unit } = countParts(lens.stats);
  return (
    <Link href={lens.href} className="gear-ix-row" title={lens.tip}>
      <span className="gear-ix-name">{lens.label}</span>
      <span className="gear-ix-spec">{lens.spec ?? "—"}</span>
      <Meter share={lens.share} title={`${Math.round(lens.share * 100)}% of this body's tagged frames`} />
      <span className="gear-ix-years">{lens.years ?? ""}</span>
      <span className="gear-ix-count">
        {n}
        <small>{unit}</small>
      </span>
    </Link>
  );
}

function Body({ body }: { body: KitBody }) {
  const meta = [body.shutter, body.split, body.elsewhere].filter(Boolean) as string[];
  return (
    <section className="gear-ix-body">
      <Link href={body.href} className="gear-ix-head" title={body.tip}>
        <span className="gear-ix-head-main">
          <span className="gear-ix-head-name">{body.label}</span>
          <span className="gear-ix-kind">{body.kindLabel}</span>
        </span>
        {meta.length > 0 && <span className="gear-ix-head-meta">{meta.join(" · ")}</span>}
        <span className="gear-ix-head-years">{body.years ?? ""}</span>
        <span className="gear-ix-head-count">{countLabel(body.stats)}</span>
      </Link>

      <div className="gear-ix-rows">
        {body.lenses.map((l) => (
          <LensRow key={l.key} lens={l} />
        ))}
        {/* The frames the lens rows can't account for, stated rather than
            dropped — otherwise the column would not sum to the body's total. */}
        {body.untagged > 0 && (
          <span className="gear-ix-row is-untagged">
            <span className="gear-ix-name">No lens recorded</span>
            <span className="gear-ix-spec">the files carry no lens tag</span>
            <span className="gear-meter" aria-hidden="true" />
            <span className="gear-ix-years" />
            <span className="gear-ix-count">
              {num(body.untagged)}
              <small>{body.untagged === 1 ? "frame" : "frames"}</small>
            </span>
          </span>
        )}
      </div>
    </section>
  );
}

export default function IndexView({ kit }: { kit: Kit }) {
  return (
    <div className="gear-index">
      {kit.bodies.map((b) => (
        <Body key={b.name} body={b} />
      ))}
    </div>
  );
}
