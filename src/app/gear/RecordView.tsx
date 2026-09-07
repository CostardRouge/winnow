"use client";

// Layout 7 — "Record": one printed sheet per body.
//
// The editorial reading. Where every other layout compresses a body into a row,
// a card or a bar, this one gives it a page: the display serif the topbar is
// otherwise alone in wearing, the raw EXIF device string set as a subtitle
// rather than hidden in a tooltip, a spec table, then the glass.
//
// It is the slowest of the eight on purpose — five bodies are five screens. That
// is the trade: this is the layout for looking at the kit, not for scanning it.
import Link from "next/link";
import type { Kit, KitBody } from "./model";
import { num } from "./model";

/** A cell of the spec table. Absent readings print an em dash rather than
 *  vanishing — a missing shutter count is itself worth seeing. */
function Spec({ term, value }: { term: string; value: string | null }) {
  return (
    <div className="gear-rec-spec">
      <dt>{term}</dt>
      <dd>{value ?? "—"}</dd>
    </div>
  );
}

function Record({ body }: { body: KitBody }) {
  return (
    <article className="gear-rec">
      <header className="gear-rec-top">
        <h3 className="gear-rec-title">
          <Link href={body.href}>{body.label}</Link>
        </h3>
        {/* The filter value, and the only unambiguous name a body has. It is a
            detail of the sheet here, not something a tooltip has to reveal. */}
        {body.name !== body.label && <span className="gear-rec-exif">{body.name}</span>}
        <span className="gear-rec-count">{num(body.stats.count)} media</span>
      </header>

      <dl className="gear-rec-specs">
        <Spec term="Type" value={body.kindLabel} />
        <Spec term="In service" value={body.years} />
        <Spec term="Photos" value={num(body.stats.photos)} />
        <Spec term="Videos" value={num(body.stats.videos)} />
        <Spec
          term="Shutter"
          value={
            body.shutterCount == null
              ? null
              : num(body.shutterCount) + (body.shutterAt ? ` · ${body.shutterAt}` : "")
          }
        />
        <Spec
          term="Without a lens tag"
          value={body.untagged > 0 ? num(body.untagged) : null}
        />
        {body.elsewhere && <Spec term="Elsewhere" value={body.elsewhere} />}
      </dl>

      {body.lenses.length > 0 && (
        <div className="gear-rec-glass">
          {body.lenses.map((l) => (
            <Link key={l.key} href={l.href} className="gear-rec-lens" title={l.tip}>
              <b>{l.label}</b>
              {l.spec && <em>{l.spec}</em>}
              <span>{num(l.stats.count)}</span>
            </Link>
          ))}
        </div>
      )}
    </article>
  );
}

export default function RecordView({ kit }: { kit: Kit }) {
  return (
    <div className="gear-records">
      {kit.bodies.map((b) => (
        <Record key={b.name} body={b} />
      ))}
    </div>
  );
}
