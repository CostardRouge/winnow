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
// reverts the rating it applied. Persistence + counts live in the parent (it
// owns `onRate` / `onUndo`); the deck only owns the gesture + animation state.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
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

// How far (px) a drag must travel to commit a verdict, and how long the card's
// fly-off animation runs before the next card takes over.
const THRESHOLD = 92;
const FLY_MS = 280;

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);
const verdictOf = (dir: Dir) =>
  dir === "right" ? "pick" : dir === "left" ? "reject" : "skip";

export default function SwipeDeck({
  cards,
  onRate,
  onUndo,
  onEmpty,
  emptyState,
}: {
  cards: DeckCard[];
  /** Persist a verdict for a swiped card (right = pick, left = reject, up = skip). */
  onRate: (card: DeckCard, verdict: "pick" | "reject" | "skip") => void;
  /** Revert the verdict of a card brought back by Undo (→ unrated). Carries the
   *  verdict being undone so the caller can keep its counts in step. */
  onUndo?: (card: DeckCard, undone: "pick" | "reject" | "skip") => void;
  /** Fired once when the last card has been dealt with. */
  onEmpty?: () => void;
  /** Shown in place of the deck once every card is done. */
  emptyState?: ReactNode;
}) {
  const [pos, setPos] = useState(0);
  const [drag, setDrag] = useState({ x: 0, y: 0, active: false });
  const [flying, setFlying] = useState<Dir | null>(null);
  // Peek: open the current (and upcoming) cards in the full-screen MediaViewer
  // overlay — a closer look + video playback without leaving the deck. Holds an
  // index into the *remaining* stack (`cards.slice(pos)`); null when closed.
  // The verdict stays a swipe gesture: the viewer is intentionally read-only so
  // the deck never loses its one-thumb purpose.
  const [peek, setPeek] = useState<number | null>(null);
  const startRef = useRef({ x: 0, y: 0 });
  const widthRef = useRef(360);
  const historyRef = useRef<Dir[]>([]);
  const emptiedRef = useRef(false);

  const done = pos >= cards.length;
  const openPeek = useCallback(() => setPeek(0), []);

  // Signal "deck cleared" to the parent exactly once.
  useEffect(() => {
    if (done && !emptiedRef.current && cards.length > 0) {
      emptiedRef.current = true;
      onEmpty?.();
    }
    if (!done) emptiedRef.current = false;
  }, [done, cards.length, onEmpty]);

  // Commit a verdict: fly the top card out, then advance after the animation.
  const commit = useCallback(
    (dir: Dir) => {
      if (flying || done) return;
      const card = cards[pos];
      if (!card) return;
      onRate(card, verdictOf(dir));
      historyRef.current.push(dir);
      setFlying(dir);
      window.setTimeout(() => {
        setFlying(null);
        setDrag({ x: 0, y: 0, active: false });
        setPos((p) => p + 1);
      }, FLY_MS);
    },
    [cards, pos, flying, done, onRate],
  );

  // Step back to the previous card, reverting a pick/reject it carried.
  const undo = useCallback(() => {
    if (flying) return;
    const last = historyRef.current.pop();
    if (last === undefined) return;
    const target = pos - 1;
    if (target < 0) {
      historyRef.current.push(last); // nothing to step back to; restore history
      return;
    }
    const card = cards[target];
    if (card) onUndo?.(card, verdictOf(last));
    setDrag({ x: 0, y: 0, active: false });
    setPos(target);
  }, [flying, pos, cards, onUndo]);

  // Keyboard: arrows / space / undo, plus Enter/I to peek. Ignored while typing
  // in a field, and while the viewer is open it owns the keyboard (Esc/arrows)
  // so swipes don't fire behind the overlay.
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
  const stack = cards.slice(pos, pos + 3);

  return (
    <div className="deck">
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
          const src =
            card.media_type === "video"
              ? `/api/assets/${card.id}/thumb`
              : `/api/assets/${card.id}/proxy`;
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
              {card.media_type === "video" &&
                (isTop ? (
                  // On the top card the play badge is live: tap it to open the
                  // viewer, which streams the video proxy with full controls.
                  <button
                    type="button"
                    className="deck-card-play"
                    aria-label="Play video"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={openPeek}
                  >
                    ▶
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
                  {/* Peek — a closer look (zoom, metadata, video) without
                      leaving the deck. Stops the pointer from starting a drag. */}
                  <button
                    type="button"
                    className="deck-card-view"
                    aria-label="Take a closer look"
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
          disabled={pos === 0 && historyRef.current.length === 0}
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

      {/* The peek overlay. It renders over the deck (a portal on <body>) rather
          than navigating away, so the deck keeps its place underneath and a
          close drops you straight back into swiping. Items are the cards still
          to sort, opened on the current one; browsing here never moves the
          deck — only swipes/buttons cast a verdict. */}
      {peek !== null && !done && (
        <MediaViewer
          items={cards.slice(pos)}
          index={Math.min(peek, cards.length - pos - 1)}
          onIndexChange={setPeek}
          onClose={() => setPeek(null)}
        />
      )}
    </div>
  );
}
