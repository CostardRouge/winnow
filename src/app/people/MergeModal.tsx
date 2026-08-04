"use client";

// "Merge into…" — fold one person's stack into another (cf. lib/people.ts,
// POST /api/people/:id/merge). Shared by the person detail page, the shelf
// cards' action menu, and the rename flow (renaming a stack to a name another
// stack already carries offers the merge right away, seeded with that name).
//
// Candidates come sorted by the API (named first, then busiest); the search
// box narrows by name — with hundreds of clustered people, scrolling for
// "Alice" is not an option.
import { useEffect, useMemo, useRef, useState } from "react";
import { fetchJson } from "@/lib/fetchJson";
import { EmptyState, Icons, LoadingState } from "@/app/ui";
import { PersonAvatar, type PersonRow } from "./PeoplePanel";

export default function MergeModal({
  selfId,
  initialQuery,
  hint,
  onClose,
  onMerged,
}: {
  /** The stack being folded away — excluded from the candidate list. */
  selfId: number;
  /** Pre-seeded search (the duplicate-name rename flow). */
  initialQuery?: string;
  /** Context line above the list; defaults to the generic merge explainer. */
  hint?: string;
  onClose: () => void;
  onMerged: (targetId: number) => void;
}) {
  const [people, setPeople] = useState<PersonRow[] | null>(null);
  const [query, setQuery] = useState(initialQuery ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchJson<{ people: PersonRow[] }>("/api/people")
      .then((d) => setPeople(d.people.filter((p) => p.id !== selfId)))
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Failed to load"),
      );
  }, [selfId]);

  useEffect(() => {
    searchRef.current?.select();
  }, []);

  const shown = useMemo(() => {
    if (!people) return null;
    const q = query.trim().toLowerCase();
    if (!q) return people;
    return people.filter((p) => (p.name ?? "unnamed").toLowerCase().includes(q));
  }, [people, query]);

  async function merge(target: PersonRow) {
    setBusy(true);
    setError(null);
    try {
      await fetchJson(`/api/people/${target.id}/merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source_id: selfId }),
      });
      onMerged(target.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Merge failed");
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-label="Merge into another person"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title">Merge into…</h2>
        <p className="hint">
          {hint ??
            "Every face of this stack moves to the person you pick; they keep their name and cover. This stack disappears."}
        </p>
        <div className="search-field">
          <span className="search-icon" aria-hidden>
            {Icons.search}
          </span>
          <input
            ref={searchRef}
            className="input search-input"
            type="search"
            placeholder="Search people…"
            aria-label="Search people to merge into"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button
              type="button"
              className="search-clear"
              aria-label="Clear the search"
              onClick={() => setQuery("")}
            >
              ×
            </button>
          )}
        </div>
        {error && (
          <div className="empty-state error" role="alert">
            {error}
          </div>
        )}
        {!shown ? (
          <LoadingState label="Loading people…" />
        ) : shown.length === 0 ? (
          <EmptyState
            title={query ? "No matching person" : "Nobody to merge into"}
            hint={query ? "Try fewer letters — unnamed stacks match “unnamed”." : undefined}
          />
        ) : (
          <div className="merge-list">
            {shown.map((p) => (
              <button
                key={p.id}
                type="button"
                className="merge-row"
                disabled={busy}
                onClick={() => merge(p)}
              >
                <PersonAvatar coverFaceId={p.cover_face_id} name={p.name} />
                <span className={`person-name${p.name ? "" : " person-unnamed"}`}>
                  {p.name ?? "Unnamed"}
                </span>
                <span className="pill person-count">
                  {p.asset_count.toLocaleString()} media
                </span>
              </button>
            ))}
          </div>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
