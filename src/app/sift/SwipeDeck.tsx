"use client";

// The Sift swipe deck — a "Tinder for photos" culling surface, built for the
// thumb. A stack of cards; the top one is dragged with one finger (or the
// mouse), and the gesture decides the verdict:
//
//   swipe RIGHT  → Pick   (accept)
//   swipe LEFT   → Reject
//   swipe UP     → Skip   (reviewed, neither kept nor culled)
//
// Skip is a real verdict, not a "deal with it later": it's a deliberate "pass"
// that counts toward the session being done, so a swiped-up card drops out of
// the to-sort deck just like a pick or reject.
//
// Tap buttons mirror the gestures for desktop / accessibility, and arrow keys
// drive it too (←/→ verdict, ↑/space skip, Backspace/U undo). Each acted card
// flies off and the next slides up; Undo walks back through the history and
// reverts the rating it applied.
//
// Two side surfaces extend the one-thumb flow without leaving it:
//   - The peek viewer (the eye button, or tapping a recent card) opens any card
//     full-screen in the MediaViewer, where the same verdict buttons let you
//     sift on the big image — handy for a closer look before committing.
//   - The recent strip below the buttons is a virtual, horizontally-scrollable
//     history of everything just sorted, so you can see what you decided and
//     re-cast a verdict on second thoughts.
//
// Persistence + counts live in the parent (it owns `onRate` / `onUndo`); the
// deck owns which cards have been acted on (the `acted` map), the gesture +
// animation state, and the two side surfaces.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { FixedSizeList } from "react-window";
import { Icons } from "@/app/ui";
import { formatBadge } from "@/lib/format";
import MediaViewer, { type ViewerItem } from "@/app/MediaViewer";

// A deck card carries everything the swipe surface needs (id, name, format
// badge) plus the full asset metadata the peek viewer renders (date, camera,
// dimensions, GPS, the RAW/Live-Photo companion…). The session assets endpoint
// already returns all of these on every row, so opening a card in the viewer
// costs no extra round-trip.
export type DeckCard = ViewerItem & {
  filename: string;
  ext: string;
  media_type: "photo" | "video";
};

type Dir = "left" | "right" | "up";
type Verdict = "pick" | "reject" | "skip";
// What we record per acted card: the verdict cast plus a monotonic sequence so
// the recent strip can show "latest first" and Undo can find the last action.
type Acted = { verdict: Verdict; seq: number };

// How far (px) a drag must travel to commit a verdict, and how long the card's
// fly-off animation runs before the next card takes over.
const THRESHOLD = 92;
const FLY_MS = 280;

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);
const verdictOf = (dir: Dir): Verdict =>
  dir === "right" ? "pick" : dir === "left" ? "reject" : "skip";

export default function SwipeDeck({
  cards,
  onRate,
  onUndo,
  onEmpty,
  emptyState,
}: {
  cards: DeckCard[];
  /** Persist a verdict for a card. `prev` is the verdict it already carried (a
   *  re-rate from the viewer / recent strip) or null for a fresh decision, so
   *  the parent can keep its counts in step without a refetch. */
  onRate: (card: DeckCard, verdict: Verdict, prev: Verdict | null) => void;
  /** Revert a card back to unrated (Undo, or clearing a verdict). Carries the
   *  verdict being undone so the caller can keep its counts in step. */
  onUndo?: (card: DeckCard, undone: Verdict) => void;
  /** Fired once when the last card has been dealt with. */
  onEmpty?: () => void;
  /** Shown in place of the deck once every card is done. */
  emptyState?: ReactNode;
}) {
  const [drag, setDrag] = useState({ x: 0, y: 0, active: false });
  const [flying, setFlying] = useState<Dir | null>(null);
  // The verdict cast on each card, keyed by id. The "deck" is whatever's left
  // unacted; everything in here has dropped out (and feeds the recent strip).
  const [acted, setActed] = useState<Map<number, Acted>>(new Map());
  // Peek: open a card full-screen in the MediaViewer overlay — a closer look +
  // video playback + the verdict buttons on the big image. Holds an index into
  // the full `cards` list (so already-sorted cards stay reachable for review);
  // null when closed.
  const [peek, setPeek] = useState<number | null>(null);
  // Inline video: the id of the video card currently playing in the deck (tap
  // the ▶ badge). Kept to the top card; cleared as the deck advances.
  const [playingId, setPlayingId] = useState<number | null>(null);
  const startRef = useRef({ x: 0, y: 0 });
  const widthRef = useRef(360);
  const seqRef = useRef(0);
  const emptiedRef = useRef(false);
  // A synchronous mirror of `acted` so the rate/undo callbacks can read the
  // current verdict of a card without waiting for the state update to flush.
  const actedRef = useRef(acted);
  const applyActed = useCallback(
    (updater: (prev: Map<number, Acted>) => Map<number, Acted>) => {
      setActed((prev) => {
        const next = updater(prev);
        actedRef.current = next;
        return next;
      });
    },
    [],
  );

  const cardsById = useMemo(() => {
    const m = new Map<number, DeckCard>();
    for (const c of cards) m.set(c.id, c);
    return m;
  }, [cards]);

  // The to-sort deck: cards that haven't been given a verdict yet, in deal order.
  const remaining = useMemo(
    () => cards.filter((c) => !acted.has(c.id)),
    [cards, acted],
  );
  const done = cards.length > 0 && remaining.length === 0;
  const top = remaining[0];

  // The recent strip's data: every acted card, latest decision first.
  const recent = useMemo(() => {
    const out: { card: DeckCard; verdict: Verdict; seq: number }[] = [];
    for (const [id, a] of acted) {
      const card = cardsById.get(id);
      if (card) out.push({ card, verdict: a.verdict, seq: a.seq });
    }
    out.sort((a, b) => b.seq - a.seq);
    return out;
  }, [acted, cardsById]);

  const openViewerAt = useCallback(
    (card: DeckCard) => setPeek(cards.findIndex((c) => c.id === card.id)),
    [cards],
  );
  const openPeek = useCallback(() => {
    if (top) openViewerAt(top);
  }, [top, openViewerAt]);

  // Signal "deck cleared" to the parent exactly once.
  useEffect(() => {
    if (done && !emptiedRef.current) {
      emptiedRef.current = true;
      onEmpty?.();
    }
    if (!done) emptiedRef.current = false;
  }, [done, onEmpty]);

  // Cast/clear a verdict on any card — the single path shared by the deck
  // buttons, the gesture, the viewer and the recent strip. Reads the card's
  // current verdict (if any) so a re-rate adjusts the parent's counts correctly,
  // and re-stamps the sequence so the strip floats the freshest decision first.
  const applyVerdict = useCallback(
    (card: DeckCard, verdict: Verdict | "unrated") => {
      const prev = actedRef.current.get(card.id)?.verdict ?? null;
      if (verdict === "unrated") {
        if (!prev) return;
        onUndo?.(card, prev);
        applyActed((m) => {
          const next = new Map(m);
          next.delete(card.id);
          return next;
        });
        return;
      }
      if (prev === verdict) return; // already this verdict — nothing to do
      onRate(card, verdict, prev);
      const seq = ++seqRef.current;
      applyActed((m) => new Map(m).set(card.id, { verdict, seq }));
    },
    [onRate, onUndo, applyActed],
  );

  // Commit the top card with the fly-off animation: rate it, animate it out,
  // then drop it from the deck so the next slides up.
  const commit = useCallback(
    (dir: Dir) => {
      if (flying || done) return;
      const card = top;
      if (!card) return;
      onRate(card, verdictOf(dir), null);
      setFlying(dir);
      setPlayingId(null);
      window.setTimeout(() => {
        setFlying(null);
        setDrag({ x: 0, y: 0, active: false });
        const seq = ++seqRef.current;
        applyActed((m) =>
          new Map(m).set(card.id, { verdict: verdictOf(dir), seq }),
        );
      }, FLY_MS);
    },
    [top, flying, done, onRate, applyActed],
  );

  // Step back the most recent decision, reverting the rating it applied.
  const undo = useCallback(() => {
    if (flying) return;
    let lastId: number | null = null;
    let lastSeq = -1;
    for (const [id, a] of actedRef.current) {
      if (a.seq > lastSeq) {
        lastSeq = a.seq;
        lastId = id;
      }
    }
    if (lastId == null) return;
    const a = actedRef.current.get(lastId)!;
    const card = cardsById.get(lastId);
    if (card) onUndo?.(card, a.verdict);
    applyActed((m) => {
      const next = new Map(m);
      next.delete(lastId!);
      return next;
    });
    setDrag({ x: 0, y: 0, active: false });
  }, [flying, cardsById, onUndo, applyActed]);

  // Keyboard: arrows / space / undo, plus Enter/I to peek. Ignored while typing
  // in a field, and while the viewer is open it owns the keyboard (Esc/arrows +
  // its own verdict keys) so swipes don't fire behind the overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (peek !== null) return;
      if (e.key === "ArrowRight") return commit("right");
      if (e.key === "ArrowLeft") return commit("left");
      if (e.key === "ArrowUp" || e.key === " ") {
        e.preventDefault();
        return commit("up");
      }
      if (e.key === "Backspace" || e.key.toLowerCase() === "u") {
        e.preventDefault();
        return undo();
      }
      if (e.key === "Enter" || e.key.toLowerCase() === "i") {
        e.preventDefault();
        return openPeek();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [commit, undo, peek, openPeek]);

  // Verdict shortcuts inside the viewer. MediaViewer owns Esc/←/→ (close +
  // navigate) and only forwards the rest here, so these never clash with
  // browsing the big image: P pick · X reject · S skip · U/Backspace undo.
  const onViewerKey = useCallback(
    (e: KeyboardEvent, item: DeckCard) => {
      const cur = actedRef.current.get(item.id)?.verdict ?? null;
      const k = e.key.toLowerCase();
      if (k === "p") return applyVerdict(item, cur === "pick" ? "unrated" : "pick");
      if (k === "x") return applyVerdict(item, cur === "reject" ? "unrated" : "reject");
      if (k === "s") return applyVerdict(item, cur === "skip" ? "unrated" : "skip");
      if (k === "u" || e.key === "Backspace") {
        e.preventDefault();
        return undo();
      }
    },
    [applyVerdict, undo],
  );

  const onPointerDown = (e: ReactPointerEvent) => {
    if (flying || done) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    widthRef.current = (e.currentTarget as HTMLElement).offsetWidth || 360;
    startRef.current = { x: e.clientX, y: e.clientY };
    setDrag({ x: 0, y: 0, active: true });
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    if (!drag.active) return;
    setDrag({
      x: e.clientX - startRef.current.x,
      y: e.clientY - startRef.current.y,
      active: true,
    });
  };
  const endDrag = () => {
    if (!drag.active) return;
    const { x, y } = drag;
    if (Math.abs(x) > Math.abs(y)) {
      if (x > THRESHOLD) return commit("right");
      if (x < -THRESHOLD) return commit("left");
    } else if (y < -THRESHOLD) {
      return commit("up");
    }
    setDrag({ x: 0, y: 0, active: false });
  };

  if (done) {
    return <div className="deck">{emptyState}</div>;
  }

  // Live gesture feedback: which verdict the current drag is heading toward, and
  // how strongly (drives the corner stamps + the button glow).
  const lean: { dir: Dir | null; strength: number } = (() => {
    if (flying) return { dir: flying, strength: 1 };
    const { x, y } = drag;
    if (Math.abs(x) > Math.abs(y)) {
      if (x > 4) return { dir: "right", strength: clamp(x / THRESHOLD, 0, 1) };
      if (x < -4) return { dir: "left", strength: clamp(-x / THRESHOLD, 0, 1) };
    } else if (y < -4) {
      return { dir: "up", strength: clamp(-y / THRESHOLD, 0, 1) };
    }
    return { dir: null, strength: 0 };
  })();

  // Render the next few cards as a stack (top card last in the DOM so it paints
  // on top); only the top one is interactive. The under-cards also warm the
  // browser cache for the upcoming previews.
  const stack = remaining.slice(0, 3);

  return (
    // `has-recent` lets the stack give back some height to the recent strip so
    // the whole surface keeps fitting a phone screen.
    <div className={`deck${recent.length > 0 ? " has-recent" : ""}`}>
      <div className="deck-stack">
        {stack.map((card, i) => {
          const isTop = i === 0;
          const depth = i; // 0 = top
          let transform: string;
          let transition: string | undefined;
          if (isTop && flying) {
            const off = widthRef.current * 1.6;
            transform =
              flying === "right"
                ? `translate(${off}px, ${drag.y}px) rotate(20deg)`
                : flying === "left"
                  ? `translate(${-off}px, ${drag.y}px) rotate(-20deg)`
                  : `translate(${drag.x}px, -150%) rotate(0deg)`;
            transition = `transform ${FLY_MS}ms var(--ease-out), opacity ${FLY_MS}ms var(--ease-out)`;
          } else if (isTop && drag.active) {
            transform = `translate(${drag.x}px, ${drag.y}px) rotate(${drag.x / 22}deg)`;
            transition = "none";
          } else if (isTop) {
            transform = "translate(0px, 0px) rotate(0deg)";
          } else {
            // Under-cards: nudged down + scaled so the deck reads as a stack.
            transform = `translateY(${depth * 14}px) scale(${1 - depth * 0.05})`;
          }
          const isVideo = card.media_type === "video";
          const src = isVideo
            ? `/api/assets/${card.id}/thumb`
            : `/api/assets/${card.id}/proxy`;
          const playing = isTop && isVideo && playingId === card.id;
          return (
            <div
              key={card.id}
              className={`deck-card${isTop ? " is-top" : ""}`}
              style={{
                transform,
                transition,
                opacity: isTop && flying ? 0 : 1,
                zIndex: stack.length - depth,
              }}
              onPointerDown={isTop ? onPointerDown : undefined}
              onPointerMove={isTop ? onPointerMove : undefined}
              onPointerUp={isTop ? endDrag : undefined}
              onPointerCancel={isTop ? endDrag : undefined}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src} alt={card.filename} draggable={false} />
              {playing && (
                // Inline playback right in the carousel: a muted, looping preview
                // over the poster. pointer-events stay off (see CSS) so the card
                // is still draggable while the clip runs.
                <video
                  className="deck-card-video"
                  src={`/api/assets/${card.id}/proxy`}
                  poster={src}
                  autoPlay
                  muted
                  loop
                  playsInline
                />
              )}
              {isVideo &&
                (isTop ? (
                  // The play badge toggles the inline preview in place — it no
                  // longer hijacks the tap to open the viewer (the eye does that).
                  <button
                    type="button"
                    className={`deck-card-play${playing ? " is-playing" : ""}`}
                    aria-label={playing ? "Pause video" : "Play video"}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      setPlayingId((p) => (p === card.id ? null : card.id));
                    }}
                  >
                    {playing ? "❚❚" : "▶"}
                  </button>
                ) : (
                  <span className="deck-card-play" aria-hidden>▶</span>
                ))}
              <span className="deck-card-badge">
                {formatBadge(card.ext, card.companion_ext, card.group_kind)}
              </span>
              <span className="deck-card-name">{card.filename}</span>

              {isTop && (
                <>
                  {/* Peek — open the big image in the viewer (where the verdict
                      buttons live too). Stops the pointer starting a drag. */}
                  <button
                    type="button"
                    className="deck-card-view"
                    aria-label="Open in viewer"
                    title="View (Enter)"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={openPeek}
                  >
                    {Icons.view}
                  </button>
                  <span
                    className="deck-stamp is-pick"
                    style={{ opacity: lean.dir === "right" ? lean.strength : 0 }}
                  >
                    Pick
                  </span>
                  <span
                    className="deck-stamp is-reject"
                    style={{ opacity: lean.dir === "left" ? lean.strength : 0 }}
                  >
                    Nope
                  </span>
                  <span
                    className="deck-stamp is-skip"
                    style={{ opacity: lean.dir === "up" ? lean.strength : 0 }}
                  >
                    Skip
                  </span>
                </>
              )}
            </div>
          );
        })}
      </div>

      <div className="deck-actions" role="group" aria-label="Verdict">
        <button
          className="deck-btn is-undo"
          onClick={undo}
          disabled={acted.size === 0}
          aria-label="Undo last swipe"
          title="Undo (Backspace)"
        >
          {Icons.undo}
        </button>
        <button
          className={`deck-btn is-reject${lean.dir === "left" ? " lean" : ""}`}
          onClick={() => commit("left")}
          aria-label="Reject"
          title="Reject (←)"
        >
          {Icons.reject}
        </button>
        <button
          className={`deck-btn is-skip${lean.dir === "up" ? " lean" : ""}`}
          onClick={() => commit("up")}
          aria-label="Skip"
          title="Skip (↑)"
        >
          {Icons.skipFwd}
        </button>
        <button
          className={`deck-btn is-pick${lean.dir === "right" ? " lean" : ""}`}
          onClick={() => commit("right")}
          aria-label="Pick"
          title="Pick (→)"
        >
          {Icons.pick}
        </button>
      </div>

      {/* Recent decisions — a virtual, scrollable history so the last calls stay
          visible and any of them can be re-cast at a glance. */}
      {recent.length > 0 && (
        <RecentStrip
          items={recent}
          onRate={(card, verdict) => applyVerdict(card, verdict)}
          onOpen={openViewerAt}
        />
      )}

      {/* The peek overlay (a portal on <body>) renders over the deck rather than
          navigating away, so a close drops you straight back into swiping. It
          spans the full card list — already-sorted cards included — so you can
          review and re-cast a verdict on the big image; the buttons mirror the
          deck's. */}
      {peek !== null && peek >= 0 && cards[peek] && (
        <MediaViewer
          items={cards}
          index={peek}
          onIndexChange={setPeek}
          onClose={() => setPeek(null)}
          onKeyDown={onViewerKey}
          renderActions={(item) => {
            const cur = acted.get(item.id)?.verdict ?? null;
            return (
              <>
                <div className="vbar-verdict">
                  <button
                    type="button"
                    className="vbar-btn"
                    onClick={undo}
                    disabled={acted.size === 0}
                    title="Undo last (U)"
                    aria-label="Undo last"
                  >
                    ↶ <span className="vbar-label">Back</span>
                  </button>
                </div>
                <div className="vbar-verdict" role="group" aria-label="Verdict">
                  <button
                    type="button"
                    className={`vbar-btn vbar-reject${cur === "reject" ? " active" : ""}`}
                    aria-pressed={cur === "reject"}
                    title="Reject (X)"
                    onClick={() =>
                      applyVerdict(item, cur === "reject" ? "unrated" : "reject")
                    }
                  >
                    ✕ <span className="vbar-label">Reject</span>
                  </button>
                  <button
                    type="button"
                    className={`vbar-btn vbar-skip${cur === "skip" ? " active" : ""}`}
                    aria-pressed={cur === "skip"}
                    title="Skip (S)"
                    onClick={() =>
                      applyVerdict(item, cur === "skip" ? "unrated" : "skip")
                    }
                  >
                    ↪ <span className="vbar-label">Skip</span>
                  </button>
                  <button
                    type="button"
                    className={`vbar-btn vbar-pick${cur === "pick" ? " active" : ""}`}
                    aria-pressed={cur === "pick"}
                    title="Pick (P)"
                    onClick={() =>
                      applyVerdict(item, cur === "pick" ? "unrated" : "pick")
                    }
                  >
                    ✓ <span className="vbar-label">Pick</span>
                  </button>
                </div>
              </>
            );
          }}
        />
      )}
    </div>
  );
}

// The recent-decisions strip: a horizontally-scrollable, virtualized row of the
// cards just sorted (latest first). Each tile shows the thumbnail (tap to open
// it big in the viewer) and the three verdict buttons with the current call lit,
// so a decision can be re-cast without hunting back through the deck. Virtual +
// width-aware (a ResizeObserver feeds react-window the available width) so a
// session with thousands of files only ever renders the handful on screen.
function RecentStrip({
  items,
  onRate,
  onOpen,
}: {
  items: { card: DeckCard; verdict: Verdict }[];
  onRate: (card: DeckCard, verdict: Verdict) => void;
  onOpen: (card: DeckCard) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      setWidth(Math.floor(entries[0].contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const ITEM = 88; // px per tile, gap included
  const HEIGHT = 100; // tile height + room for the horizontal scrollbar

  const Tile = ({ index, style }: { index: number; style: React.CSSProperties }) => {
    const { card, verdict } = items[index];
    return (
      <div style={style}>
        <div className={`sift-recent-card is-${verdict}`}>
          <button
            type="button"
            className="sift-recent-thumb"
            onClick={() => onOpen(card)}
            title="Open in viewer"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/api/assets/${card.id}/thumb`} alt={card.filename} loading="lazy" />
            {card.media_type === "video" && (
              <span className="sift-recent-play" aria-hidden>▶</span>
            )}
          </button>
          <div className="sift-recent-acts" role="group" aria-label="Re-cast verdict">
            <button
              type="button"
              className={`sift-recent-btn is-reject${verdict === "reject" ? " on" : ""}`}
              onClick={() => onRate(card, "reject")}
              aria-label="Reject"
              aria-pressed={verdict === "reject"}
            >
              ✕
            </button>
            <button
              type="button"
              className={`sift-recent-btn is-skip${verdict === "skip" ? " on" : ""}`}
              onClick={() => onRate(card, "skip")}
              aria-label="Skip"
              aria-pressed={verdict === "skip"}
            >
              ↪
            </button>
            <button
              type="button"
              className={`sift-recent-btn is-pick${verdict === "pick" ? " on" : ""}`}
              onClick={() => onRate(card, "pick")}
              aria-label="Pick"
              aria-pressed={verdict === "pick"}
            >
              ✓
            </button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="sift-recent">
      <div className="sift-recent-head">
        Recent decisions <span className="sift-recent-count">{items.length}</span>
      </div>
      <div ref={trackRef} className="sift-recent-track">
        {width > 0 && (
          <FixedSizeList
            layout="horizontal"
            height={HEIGHT}
            width={width}
            itemCount={items.length}
            itemSize={ITEM}
            overscanCount={6}
          >
            {Tile}
          </FixedSizeList>
        )}
      </div>
    </div>
  );
}
