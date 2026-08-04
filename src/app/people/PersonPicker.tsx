"use client";

// Person-picking dialog, shared by every People flow that targets "someone
// else": merging a stack away (shelf ⋯ menu, detail page, the duplicate-name
// rename offer) and moving selected media's faces off a stack (the bad-merge
// repair). The caller says what picking MEANS via `confirm` — this component
// owns the list, the search, and the busy/error plumbing.
//
// Candidates come sorted by the API (named first, then busiest); hidden people
// are left out (hiding a stack means not being offered it). The search matches
// accent/case-insensitively (cf. lib/nameMatch) — "chloe" finds "Chloé" — and
// unnamed stacks match "unnamed". `pinnedLabel` adds one action row above the
// list that confirms with null — the "fresh unnamed stack" option of the
// move flow.
import { useEffect, useMemo, useRef, useState } from "react";
import { fetchJson } from "@/lib/fetchJson";
import { normalizeName } from "@/lib/nameMatch";
import { EmptyState, Icons, LoadingState } from "@/app/ui";
import { PersonAvatar, type PersonRow } from "./PeoplePanel";

export default function PersonPicker({
  selfId,
  title,
  hint,
  initialQuery,
  pinnedLabel,
  pinnedHint,
  confirm,
  onClose,
}: {
  /** The stack the action operates on — excluded from the candidates. */
  selfId: number;
  title: string;
  hint: string;
  /** Pre-seeded search (the duplicate-name rename flow). */
  initialQuery?: string;
  /** When set, a pinned first row that confirms with `null` (no target). */
  pinnedLabel?: string;
  pinnedHint?: string;
  /** Performs the action; a thrown error is shown and the dialog stays open. */
  confirm: (target: PersonRow | null) => Promise<void>;
  onClose: () => void;
}) {
  const [people, setPeople] = useState<PersonRow[] | null>(null);
  const [query, setQuery] = useState(initialQuery ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchJson<{ people: PersonRow[] }>("/api/people")
      .then((d) =>
        setPeople(d.people.filter((p) => p.id !== selfId && !p.hidden)),
      )
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Failed to load"),
      );
  }, [selfId]);

  useEffect(() => {
    searchRef.current?.select();
  }, []);

  const shown = useMemo(() => {
    if (!people) return null;
    const q = normalizeName(query);
    if (!q) return people;
    return people.filter((p) =>
      normalizeName(p.name ?? "unnamed").includes(q),
    );
  }, [people, query]);

  async function pick(target: PersonRow | null) {
    setBusy(true);
    setError(null);
    try {
      await confirm(target);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title">{title}</h2>
        <p className="hint">{hint}</p>
        <div className="search-field">
          <span className="search-icon" aria-hidden>
            {Icons.search}
          </span>
          <input
            ref={searchRef}
            className="input search-input"
            type="search"
            placeholder="Search people…"
            aria-label="Search people"
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
        {pinnedLabel && (
          <button
            type="button"
            className="merge-row merge-row-pinned"
            disabled={busy}
            onClick={() => pick(null)}
            title={pinnedHint}
          >
            <span className="person-avatar merge-pinned-ic" aria-hidden>
              <span className="person-avatar-fallback">{Icons.people}</span>
            </span>
            <span className="person-name">{pinnedLabel}</span>
          </button>
        )}
        {!shown ? (
          <LoadingState label="Loading people…" />
        ) : shown.length === 0 ? (
          <EmptyState
            title={query ? "No matching person" : "Nobody else"}
            hint={
              query
                ? "Try fewer letters — unnamed stacks match “unnamed”."
                : undefined
            }
          />
        ) : (
          <div className="merge-list">
            {shown.map((p) => (
              <button
                key={p.id}
                type="button"
                className="merge-row"
                disabled={busy}
                onClick={() => pick(p)}
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
