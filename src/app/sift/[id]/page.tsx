"use client";

// One session's fast triage: load everything still unrated (and ready to
// preview) into the swipe deck, then pick / reject / skip card by card. When the
// deck empties the session is offered up as "done" and the next session still
// needing attention is one tap away — so culling a backlog is a continuous flow
// rather than a round-trip through the list each time.

import { useCallback, useEffect, useState, use as usePromise } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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
type Counts = { picks: number; rejects: number; total: number };

export default function SiftSessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = usePromise(params);
  const router = useRouter();

  const [name, setName] = useState<string>("");
  const [cards, setCards] = useState<DeckCard[] | null>(null);
  const [counts, setCounts] = useState<Counts>({ picks: 0, rejects: 0, total: 0 });
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
        setCounts({
          picks: Number(d.session.pick_count) || 0,
          rejects: Number(d.session.reject_count) || 0,
          total:
            (Number(d.session.pick_count) || 0) +
            (Number(d.session.reject_count) || 0) +
            (Number(d.session.unrated_count) || 0),
        });
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

  const rate = useCallback(
    (card: DeckCard, verdict: "pick" | "reject") => {
      setSwiped((n) => n + 1);
      setCounts((c) => ({
        ...c,
        picks: c.picks + (verdict === "pick" ? 1 : 0),
        rejects: c.rejects + (verdict === "reject" ? 1 : 0),
      }));
      void fetch(`/api/assets/${card.id}/rating`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verdict }),
      });
    },
    [],
  );

  const undo = useCallback((card: DeckCard, undone: "pick" | "reject") => {
    setSwiped((n) => Math.max(0, n - 1));
    setFinished(false);
    setCounts((c) => ({
      ...c,
      picks: c.picks - (undone === "pick" ? 1 : 0),
      rejects: c.rejects - (undone === "reject" ? 1 : 0),
    }));
    void fetch(`/api/assets/${card.id}/rating`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verdict: "unrated" }),
    });
  }, []);

  const markComplete = useCallback(async () => {
    await fetch(`/api/sessions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ completed: true }),
    });
    router.push("/sift");
  }, [id, router]);

  const total = cards?.length ?? 0;
  const left = Math.max(0, total - swiped);

  return (
    <div className="sift-deck-page">
      <div className="topbar">
        <Link href="/sift" className="btn btn-icon" aria-label="Back to Sift">
          {Icons.back}
        </Link>
        <h1 className="sift-deck-title">{name || `Session #${id}`}</h1>
        <span className="spacer" />
        {cards && !finished && (
          <span className="hint">
            {left} left{total ? ` / ${total}` : ""}
          </span>
        )}
      </div>

      <div className="sift-deck-progress">
        <SessionProgress picks={counts.picks} rejects={counts.rejects} total={counts.total} />
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
            nextId={nextId}
            onComplete={markComplete}
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
                subtitle={`${counts.picks} kept · ${counts.rejects} rejected`}
                nextId={nextId}
                onComplete={markComplete}
              />
            }
          />
        )}
      </div>
    </div>
  );
}

// Shown when the deck runs dry: celebrate, then hand off to the next session
// that still needs triage (or back to the Sift hub), and offer to flag this one
// done so it drops out of the "to sort" lists.
function CompletionPanel({
  title,
  subtitle,
  nextId,
  onComplete,
}: {
  title: string;
  subtitle: string;
  nextId: number | null;
  onComplete: () => void;
}) {
  return (
    <div className="sift-done">
      <div className="sift-done-mark" aria-hidden>
        {Icons.pick}
      </div>
      <h2>{title}</h2>
      <p>{subtitle}</p>
      <div className="sift-done-actions">
        <button className="btn" onClick={onComplete}>
          {Icons.keep} Mark complete
        </button>
        {nextId != null ? (
          <Link href={`/sift/${nextId}`} className="btn btn-primary">
            {Icons.skipFwd} Next session
          </Link>
        ) : (
          <Link href="/sift" className="btn btn-primary">
            Back to Sift
          </Link>
        )}
      </div>
    </div>
  );
}
