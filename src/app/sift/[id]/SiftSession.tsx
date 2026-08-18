"use client";

// One session's fast triage: load everything still unrated (and ready to
// preview) into the swipe deck, then pick / reject / skip card by card. When the
// deck empties the session is offered up as "done" and the next session still
// needing attention is one tap away — so culling a backlog is a continuous flow
// rather than a round-trip through the list each time.

import { useCallback, useEffect, useState, use as usePromise } from "react";
import Link from "next/link";
import { fetchJson } from "@/lib/fetchJson";
import { Icons } from "@/app/ui";
import SessionProgress from "@/app/sessions/SessionProgress";
import SwipeDeck, { type DeckCard } from "@/app/sift/SwipeDeck";

type SessionInfo = {
  id: number;
  name: string;
  root_kind: string;
  pick_count: number | string;
  reject_count: number | string;
  skip_count: number | string;
  unrated_count: number | string;
};

type SessionRow = {
  id: number;
  name: string;
  unrated_count: number;
  pick_count: number;
  reject_count: number;
};

// Each verdict is mirrored locally so the progress bar / counter move with every
// swipe without a round-trip to refetch the session.
type Counts = { picks: number; rejects: number; skips: number; total: number };

export default function SiftSessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = usePromise(params);

  const [name, setName] = useState<string>("");
  const [cards, setCards] = useState<DeckCard[] | null>(null);
  const [counts, setCounts] = useState<Counts>({ picks: 0, rejects: 0, skips: 0, total: 0 });
  const [swiped, setSwiped] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const [nextId, setNextId] = useState<number | null>(null);

  // Load the session header (name + verdict counts seed the progress bar).
  useEffect(() => {
    let off = false;
    fetchJson<{ session: SessionInfo }>(`/api/sessions/${id}`)
      .then((d) => {
        if (off) return;
        setName(d.session.name);
        const picks = Number(d.session.pick_count) || 0;
        const rejects = Number(d.session.reject_count) || 0;
        const skips = Number(d.session.skip_count) || 0;
        const unrated = Number(d.session.unrated_count) || 0;
        setCounts({ picks, rejects, skips, total: picks + rejects + skips + unrated });
      })
      .catch((e) => !off && setError((e as Error).message));
    return () => {
      off = true;
    };
  }, [id]);

  // Load every unrated, ready-to-preview card, paging through the cursor so a
  // big session deals the whole backlog (capped to keep memory sane).
  useEffect(() => {
    let off = false;
    (async () => {
      try {
        const all: DeckCard[] = [];
        let cursor: string | null = null;
        for (let guard = 0; guard < 20; guard++) {
          const sp = new URLSearchParams({
            verdict: "unrated",
            derivative_status: "ready",
            collapse: "1",
          });
          if (cursor) sp.set("cursor", cursor);
          const data = await fetchJson<{
            assets?: DeckCard[];
            next_cursor?: string | null;
          }>(`/api/sessions/${id}/assets?${sp.toString()}`);
          all.push(...(data.assets ?? []));
          cursor = data.next_cursor ?? null;
          if (!cursor || all.length >= 2000) break;
        }
        if (!off) setCards(all);
      } catch (e) {
        if (!off) setError((e as Error).message);
      }
    })();
    return () => {
      off = true;
    };
  }, [id]);

  // Find the next session still needing triage (most recently touched first),
  // skipping this one — powers the "Next session" hand-off on completion.
  useEffect(() => {
    let off = false;
    fetchJson<{ sessions?: SessionRow[] }>(
      "/api/sessions?kind=incoming&progress=incomplete&sort=touched&sort_dir=desc",
    )
      .then((d) => {
        if (off) return;
        const next = (d.sessions ?? []).find((s) => String(s.id) !== String(id));
        setNextId(next ? next.id : null);
      })
      .catch(() => {});
    return () => {
      off = true;
    };
  }, [id]);

  // Persist a verdict. `prev` is the verdict the card already carried — null for
  // a fresh swipe (which advances the "swiped" counter), or a real verdict when
  // a card is re-cast from the viewer / recent strip (counters shift but the
  // card was already off the deck, so "swiped" holds steady).
  const rate = useCallback(
    (
      card: DeckCard,
      verdict: "pick" | "reject" | "skip",
      prev: "pick" | "reject" | "skip" | null,
    ) => {
      if (!prev) setSwiped((n) => n + 1);
      setCounts((c) => ({
        ...c,
        picks: c.picks + (verdict === "pick" ? 1 : 0) - (prev === "pick" ? 1 : 0),
        rejects:
          c.rejects + (verdict === "reject" ? 1 : 0) - (prev === "reject" ? 1 : 0),
        skips: c.skips + (verdict === "skip" ? 1 : 0) - (prev === "skip" ? 1 : 0),
      }));
      void fetch(`/api/assets/${card.id}/rating`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verdict }),
      });
    },
    [],
  );

  const undo = useCallback((card: DeckCard, undone: "pick" | "reject" | "skip") => {
    setSwiped((n) => Math.max(0, n - 1));
    setFinished(false);
    setCounts((c) => ({
      ...c,
      picks: c.picks - (undone === "pick" ? 1 : 0),
      rejects: c.rejects - (undone === "reject" ? 1 : 0),
      skips: c.skips - (undone === "skip" ? 1 : 0),
    }));
    void fetch(`/api/assets/${card.id}/rating`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verdict: "unrated" }),
    });
  }, []);

  const total = cards?.length ?? 0;
  const left = Math.max(0, total - swiped);

  return (
    <div className="sift-deck-page">
      <div className="topbar">
        <Link href="/sift" className="btn btn-icon" aria-label="Back to Sift">
          {Icons.back}
        </Link>
        <h1 className="sift-deck-title">{name || `Session #${id}`}</h1>
      </div>

      {/* Status bar above the carousel: how much is left, the overall progress
          bar, and a quick jump into the full session view — all in the dead
          space that used to sit empty above the deck. */}
      <div className="sift-deck-statusbar">
        <span className="sift-deck-left" aria-live="polite">
          {!cards ? (
            "Loading…"
          ) : !finished && total > 0 ? (
            <>
              <strong>{left}</strong> left
              <span className="sift-deck-total"> / {total}</span>
            </>
          ) : (
            "All sorted"
          )}
        </span>
        <SessionProgress
          picks={counts.picks}
          rejects={counts.rejects}
          skips={counts.skips}
          total={counts.total}
          compact
          className="sift-deck-statusbar-progress"
        />
        <Link
          href={`/sessions/${id}`}
          className="btn btn-sm sift-deck-open"
          title="Open the full session"
        >
          {Icons.view} <span className="max-sm:hidden">Open session</span>
        </Link>
      </div>

      <div className="sift-deck-body">
        {error ? (
          <div className="error-box">
            <span>Couldn’t load this session: {error}</span>
          </div>
        ) : !cards ? (
          <div className="spinner">Dealing the deck…</div>
        ) : cards.length === 0 ? (
          <CompletionPanel
            title="Nothing left to sort here"
            subtitle="Every ready file in this session already has a verdict."
            sessionId={id}
            nextId={nextId}
          />
        ) : (
          <SwipeDeck
            cards={cards}
            onRate={rate}
            onUndo={undo}
            onEmpty={() => setFinished(true)}
            emptyState={
              <CompletionPanel
                title="Session sorted! 🎉"
                subtitle={`${counts.picks} kept · ${counts.rejects} rejected${
                  counts.skips > 0 ? ` · ${counts.skips} skipped` : ""
                }`}
                sessionId={id}
                nextId={nextId}
              />
            }
          />
        )}
      </div>
    </div>
  );
}

// Shown when the deck runs dry: every card now carries a verdict, so the session
// is automatically "done" — no flag to set. Celebrate (with the run's tally),
// then offer two ways onward: straight into the next session that still needs
// triage, or back into the one just sorted to review the picks before exporting.
function CompletionPanel({
  title,
  subtitle,
  sessionId,
  nextId,
}: {
  title: string;
  subtitle: string;
  sessionId: string;
  nextId: number | null;
}) {
  return (
    <div className="sift-done">
      <div className="sift-done-mark" aria-hidden>
        {Icons.pick}
      </div>
      <h2>{title}</h2>
      <p>{subtitle}</p>
      <div className="sift-done-actions">
        {nextId != null ? (
          <Link href={`/sift/${nextId}`} className="btn btn-primary">
            {Icons.skipFwd} Next session
          </Link>
        ) : (
          <Link href="/sift" className="btn btn-primary">
            {Icons.sift} Back to Sift
          </Link>
        )}
        {/* The lighter, secondary path: reopen the session just triaged to look
            over the picks and export them when happy. */}
        <Link href={`/sessions/${sessionId}`} className="btn">
          {Icons.view} Open sorted session
        </Link>
      </div>
    </div>
  );
}
