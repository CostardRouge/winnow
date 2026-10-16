"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { geotagAssets, geotagTargets, type GeotagAsset } from "@/lib/assetActions";
import { distanceM, type UnplacedGroup } from "@/lib/unplacedTypes";
import { distText, spanText } from "@/lib/unplacedFormat";
import type { PickedLocation } from "@/app/LocationPicker";

// Review the Ready cards one after another, from the keyboard
// (docs/UNPLACED.md §11): the card's map with its suggested pin, what will be
// recorded, a few of its frames — Enter applies, → skips, ← goes back, Esc
// returns to the list. The maintainer's "glance, confirm" pass over the
// hundreds of cards whose suggestion is already confident, without opening
// and closing a dialog per card.
//
// The recap's rule is kept, not skipped: a card whose media ALL lack a
// position has nothing for the recap to protect, so Enter writes it directly;
// a card where some media already carry a position is never one key — the
// review hands it to the full recap, which lists exactly those rows. What is
// recorded is decided as everywhere else: the pin as offered records
// 'inferred', a pin moved past move_m records 'manual'.
//
// A card made confident by DISTANCE (tight_km, §12) shows why as a strip: the
// located frame before it, the card, the frame after — with the gap in time
// and the distance from the pin — so "high" is something to check, not to
// trust. The media the view sets aside (screenshots, saved, graded) are left
// out of the write, as on the cards.

const LocationPicker = dynamic(() => import("@/app/LocationPicker"), { ssr: false });

const fmt = (n: number) => n.toLocaleString("en-GB");

type Loaded = { assets: GeotagAsset[]; error: string | null };

export default function ReviewReady({
  groups,
  moveM,
  describe,
  onOpenRecap,
  onClose,
}: {
  groups: UnplacedGroup[];
  moveM: number;
  /** The card's window and its suggestion's provenance, in the page's words. */
  describe: (g: UnplacedGroup) => { when: string; note: string | null };
  /** Hand a card with already-placed media to the full recap. */
  onOpenRecap: (g: UnplacedGroup) => void;
  onClose: (changed: boolean) => void;
}) {
  const [i, setI] = useState(0);
  const [loc, setLoc] = useState<PickedLocation | null>(null);
  const [loaded, setLoaded] = useState<Map<string, Loaded>>(() => new Map());
  const [done, setDone] = useState<Map<string, "placed" | "skipped">>(() => new Map());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const asked = useRef(new Set<string>());

  const g = groups[i] ?? null;
  const seed = g?.suggestion ? { lat: g.suggestion.lat, lon: g.suggestion.lon } : null;

  // The card's media, and the next one's ahead of time: Enter should never
  // wait on a request the reviewer could see coming.
  const load = useCallback((card: UnplacedGroup | undefined) => {
    if (!card || asked.current.has(card.key)) return;
    asked.current.add(card.key);
    const p =
      card.kind === "part"
        ? geotagTargets([card.sessions[0].id], { from: card.t0, to: card.t1 })
        : geotagTargets(card.sessions.map((s) => s.id));
    p.then((list) => {
      const assets = list.filter((a) => !a.aside);
      setLoaded((m) => new Map(m).set(card.key, { assets, error: null }));
    }).catch((e) =>
      setLoaded((m) => new Map(m).set(card.key, { assets: [], error: (e as Error).message })),
    );
  }, []);
  useEffect(() => {
    load(groups[i]);
    load(groups[i + 1]);
  }, [i, groups, load]);

  // Each card opens on its own suggestion.
  useEffect(() => {
    const s = groups[i]?.suggestion;
    setLoc(s ? { lat: s.lat, lon: s.lon, label: s.name } : null);
    setMsg(null);
  }, [i, groups]);

  const cur = g ? loaded.get(g.key) : undefined;
  const holes = cur?.assets.filter((a) => !a.gps) ?? [];
  const placed = (cur?.assets.length ?? 0) - holes.length;
  const source = seed && loc && distanceM(seed, loc) <= moveM ? "inferred" : "manual";

  const next = useCallback(() => setI((k) => Math.min(groups.length, k + 1)), [groups.length]);
  const prev = useCallback(() => setI((k) => Math.max(0, k - 1)), []);

  const apply = useCallback(async () => {
    if (!g || !loc || busy || !cur || cur.error || placed > 0 || !holes.length) return;
    // Stepping back onto a card already placed here must not write it again:
    // its media list is the one read before the write.
    if (done.get(g.key) === "placed") return;
    setBusy(true);
    try {
      const n = await geotagAssets(
        holes.map((a) => a.id),
        { lat: loc.lat, lon: loc.lon },
        source,
      );
      setDone((m) => new Map(m).set(g.key, "placed"));
      setMsg(`${fmt(n)} placed`);
      next();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [g, loc, busy, cur, placed, holes, source, next, done]);

  const changed = [...done.values()].some((v) => v === "placed");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.key === "Escape") return onClose(changed);
      if (e.key === "Enter") {
        e.preventDefault();
        void apply();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (g) setDone((m) => new Map(m).set(g.key, m.get(g.key) ?? "skipped"));
        next();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        prev();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [apply, next, prev, onClose, changed, g]);

  const nPlaced = [...done.values()].filter((v) => v === "placed").length;
  const nSkipped = [...done.values()].filter((v) => v === "skipped").length;
  const d = g ? describe(g) : null;

  return (
    <div className="modal-overlay review-overlay" role="presentation">
      <div className="modal review-modal" role="dialog" aria-modal="true" aria-label="Review ready cards">
        <header className="review-head">
          <button type="button" className="btn btn-sm" onClick={() => onClose(changed)}>
            ← Back to the list
          </button>
          <h2 className="modal-title">Review ready cards</h2>
          <span className="hint review-count">
            <strong>{fmt(Math.min(i + 1, groups.length))}</strong> of {fmt(groups.length)} · {fmt(nPlaced)} placed · {fmt(nSkipped)} skipped
          </span>
          <span className="review-bar" aria-hidden="true">
            <span style={{ width: `${groups.length ? (Math.min(i, groups.length) / groups.length) * 100 : 0}%` }} />
          </span>
        </header>

        {!g ? (
          <div className="review-end">
            <p>
              That was the last one — {fmt(nPlaced)} placed, {fmt(nSkipped)} skipped.
            </p>
            <button type="button" className="btn btn-primary" onClick={() => onClose(changed)}>
              Back to the list
            </button>
          </div>
        ) : (
          <div className="review-body">
            <LocationPicker key={g.key} layout="split" value={loc} onChange={setLoc} inputId="review-place"
              aside={
                <div className="review-aside">
                  <h3 className="review-title">{g.sessions[0].name}</h3>
                  <p className="hint">
                    {d?.when} · {g.sessions[0].device_hint ?? "unknown device"} · <strong>{fmt(g.unplaced)}</strong> unplaced
                  </p>
                  <p className="recap-kind">
                    <span className={source === "inferred" ? "conf" : "conf is-high"}>
                      {source === "inferred" ? "suggested" : "verified"}
                    </span>
                    {source === "inferred"
                      ? "Recorded in Winnow only — never written into the originals."
                      : "You moved the pin: written into each original file’s metadata."}
                  </p>
                  {g.suggestion?.evidence ? (
                    <Evidence g={g} />
                  ) : (
                    d?.note && <p className="hint">{d.note}</p>
                  )}
                  <div className="review-thumbs">
                    {g.sample.slice(0, 6).map((a) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img key={a.id} src={`/api/assets/${a.id}/thumb`} alt="" loading="lazy" />
                    ))}
                  </div>
                  {done.get(g.key) === "placed" ? (
                    <p className="hint">Placed in this review. → for the next card.</p>
                  ) : !cur ? (
                    <p className="hint">Listing the media…</p>
                  ) : cur.error ? (
                    <p className="modal-warn">{cur.error}</p>
                  ) : placed > 0 ? (
                    <p className="modal-warn">
                      {fmt(placed)} media here already carry a position — this card needs the full recap.{" "}
                      <button type="button" className="btn btn-sm" onClick={() => onOpenRecap(g)}>
                        Open the recap
                      </button>
                    </p>
                  ) : (
                    <p className="hint">No media here carries a position yet — nothing to protect: Apply writes all {fmt(holes.length)}.</p>
                  )}
                  {msg && <p className="hint" role="status">{msg}</p>}
                  <div className="review-actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={busy || !cur || !!cur.error || placed > 0 || !loc || done.get(g.key) === "placed"}
                      onClick={() => void apply()}
                    >
                      {busy ? "Placing…" : `Apply to ${fmt(holes.length || g.unplaced)}`} <kbd>Enter</kbd>
                    </button>
                    <button type="button" className="btn" onClick={() => {
                      setDone((m) => new Map(m).set(g.key, m.get(g.key) ?? "skipped"));
                      next();
                    }}>
                      Skip <kbd>→</kbd>
                    </button>
                    <button type="button" className="btn" onClick={prev} disabled={i === 0}>
                      Back <kbd>←</kbd>
                    </button>
                  </div>
                </div>
              }
            />
          </div>
        )}
        <footer className="review-keys hint">
          <span><kbd>Enter</kbd> apply</span>
          <span><kbd>→</kbd> skip</span>
          <span><kbd>←</kbd> previous</span>
          <span>drag the pin → verified</span>
          <span><kbd>Esc</kbd> back to the list</span>
        </footer>
      </div>
    </div>
  );
}

// The located frames that made the card confident, around it in time.
function Evidence({ g }: { g: UnplacedGroup }) {
  const s = g.suggestion!;
  const e = s.evidence!;
  const pin = { lat: s.lat, lon: s.lon };
  const side = (f: NonNullable<typeof e.before>, gap: number, word: string) => (
    <li>
      <span className="review-ev-file" title={f.filename}>
        {f.filename}
      </span>
      <span className="hint">
        {spanText(gap)} {word}
        {f.model ? ` · ${f.model}` : ""} · {distText(distanceM(f, pin))} from the pin
      </span>
    </li>
  );
  return (
    <div className="review-evidence">
      <span className="modal-label">
        Why {s.confidence}: {e.basis === "bracketed" ? "located on both sides" : e.basis === "one_side" ? "located on one side" : "located among these hours"}
      </span>
      <ol>
        {e.before && side(e.before, Date.parse(g.t0) - Date.parse(e.before.at), "before")}
        <li className="is-here">
          <span>{g.unplaced === 1 ? "This one" : `These ${fmt(g.unplaced)}`}</span>
          {e.inside > 0 && <span className="hint">{fmt(e.inside)} located among them</span>}
        </li>
        {e.after && side(e.after, Date.parse(e.after.at) - Date.parse(g.t1), "after")}
      </ol>
      <span className="hint">All within {distText(e.spread_m)} of each other.</span>
    </div>
  );
}
