"use client";

// Merge suggestions: pairs of stacks whose average faces almost match — the
// clusterer's near-misses (GET /api/people/suggestions). Each row shows the
// two stacks side by side with their match strength; one click merges the
// pair, the × dismisses it for this visit (dismissals aren't persisted — a
// pair that really is two people simply stays un-merged and reappears next
// time, which costs one glance).
//
// Merge direction is chosen for the user: into the NAMED one (a name is
// curation worth keeping), else into the bigger stack — same rule either way:
// the stack with more invested wins.
import { useMemo, useState } from "react";
import Link from "next/link";
import { fetchJson } from "@/lib/fetchJson";
import { EmptyState } from "@/app/ui";
import { PersonAvatar, type PersonRow } from "./PeoplePanel";

export type MergeSuggestion = { a: number; b: number; similarity: number };

function pickTarget(a: PersonRow, b: PersonRow): [PersonRow, PersonRow] {
  // [target, source]: named beats unnamed; then the larger stack wins.
  if (a.name != null && b.name == null) return [a, b];
  if (b.name != null && a.name == null) return [b, a];
  return a.asset_count >= b.asset_count ? [a, b] : [b, a];
}

export default function SuggestionsModal({
  suggestions,
  people,
  onClose,
  onMerged,
}: {
  suggestions: MergeSuggestion[];
  people: PersonRow[];
  onClose: () => void;
  /** A merge happened — the caller refetches people + suggestions. */
  onMerged: () => void;
}) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const byId = useMemo(
    () => new Map(people.map((p) => [p.id, p])),
    [people],
  );
  const rows = suggestions
    .map((s) => {
      const a = byId.get(s.a);
      const b = byId.get(s.b);
      return a && b ? { key: `${s.a}-${s.b}`, a, b, similarity: s.similarity } : null;
    })
    .filter(Boolean)
    .filter((r) => !dismissed.has(r!.key)) as {
    key: string;
    a: PersonRow;
    b: PersonRow;
    similarity: number;
  }[];

  async function merge(row: (typeof rows)[number]) {
    const [target, source] = pickTarget(row.a, row.b);
    setBusyKey(row.key);
    setError(null);
    try {
      await fetchJson(`/api/people/${target.id}/merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source_id: source.id }),
      });
      onMerged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Merge failed");
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div
        className="modal modal-wide"
        role="dialog"
        aria-label="Merge suggestions"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title">Probably the same person</h2>
        <p className="hint">
          These stacks' average faces almost match — usually one person the
          clusterer split (glasses, lighting, years apart). Nothing merges on
          its own: review each pair. The merge keeps the named (or bigger)
          stack.
        </p>
        {error && (
          <div className="empty-state error" role="alert">
            {error}
          </div>
        )}
        {rows.length === 0 ? (
          <EmptyState title="Nothing left to review" />
        ) : (
          <div className="merge-list">
            {rows.map((row) => {
              const [target, source] = pickTarget(row.a, row.b);
              return (
                <div key={row.key} className="suggest-row">
                  <Link
                    href={`/people/${source.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="person-link"
                    title={`View ${source.name ?? "Unnamed"}'s profile`}
                  >
                    <PersonAvatar
                      coverFaceId={source.cover_face_id}
                      name={source.name}
                    />
                    <span
                      className={`person-name${source.name ? "" : " person-unnamed"}`}
                    >
                      {source.name ?? "Unnamed"}
                    </span>
                  </Link>
                  <span className="suggest-arrow" aria-hidden>
                    →
                  </span>
                  <Link
                    href={`/people/${target.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="person-link"
                    title={`View ${target.name ?? "Unnamed"}'s profile`}
                  >
                    <PersonAvatar
                      coverFaceId={target.cover_face_id}
                      name={target.name}
                    />
                    <span
                      className={`person-name${target.name ? "" : " person-unnamed"}`}
                    >
                      {target.name ?? "Unnamed"}
                    </span>
                  </Link>
                  <span
                    className="pill merge-sim"
                    title="How closely the two stacks' average faces match"
                  >
                    {Math.round(row.similarity * 100)}%
                  </span>
                  <span className="spacer" />
                  <button
                    className="btn btn-primary"
                    disabled={busyKey !== null}
                    onClick={() => merge(row)}
                  >
                    Merge
                  </button>
                  <button
                    className="btn"
                    disabled={busyKey !== null}
                    title="Not the same person — put this pair aside for now"
                    onClick={() =>
                      setDismissed((d) => new Set(d).add(row.key))
                    }
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
