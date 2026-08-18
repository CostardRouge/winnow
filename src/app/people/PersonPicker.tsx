"use client";

// Person-picking dialog, shared by every People flow that targets "someone
// else": merging a stack away (shelf ⋯ menu, detail page, the duplicate-name
// rename offer) and moving selected media's faces off a stack (the bad-merge
// repair). The caller says what picking MEANS via `confirm` — this component
// owns the list, the search, and the busy/error plumbing.
//
// Candidates come sorted by the API — look-alikes first (centroid proximity),
// a name only breaking ties; hidden people are left out (hiding a stack means
// not being offered it). The search matches
// accent/case-insensitively (cf. lib/nameMatch) — "chloe" finds "Chloé" — and
// unnamed stacks match "unnamed". `pinnedLabel` adds one action row above the
// list that confirms with null — the "fresh unnamed stack" option of the
// move flow.
//
// MULTI mode (`multi` prop, merge flows only): each row grows a checkbox in
// its spare right edge. Ticking flips the dialog's direction — instead of
// folding the current stack into ONE clicked row, the CHECKED rows fold into
// the current stack ("these four are also her"), all in one confirm. The
// proximity ranking makes this fast: the look-alikes to tick are the top rows.
// With nothing ticked, a row click keeps the classic single merge-into.
import { useEffect, useMemo, useRef, useState } from "react";
import { fetchJson } from "@/lib/fetchJson";
import { normalizeName } from "@/lib/nameMatch";
import { EmptyState, Icons, LoadingState } from "@/app/ui";
import { PersonAvatar, type PersonRow } from "./PeoplePanel";

export default function PersonPicker({
  selfId,
  excludeIds,
  title,
  hint,
  initialQuery,
  pinnedLabel,
  pinnedHint,
  confirm,
  multi,
  onClose,
}: {
  /** The stack the action operates on — excluded from the candidates, and the
   *  reference for the proximity ranking. */
  selfId: number;
  /** Additional stacks to leave out (a bulk merge excludes every source). */
  excludeIds?: number[];
  title: string;
  hint: string;
  /** Pre-seeded search (the duplicate-name rename flow). */
  initialQuery?: string;
  /** When set, a pinned first row that confirms with `null` (no target). */
  pinnedLabel?: string;
  pinnedHint?: string;
  /** Performs the action; a thrown error is shown and the dialog stays open. */
  confirm: (target: PersonRow | null) => Promise<void>;
  /** Multi-check mode: rows grow checkboxes, and confirming folds every
   *  CHECKED stack into the current one (reverse of the single-click flow). */
  multi?: {
    /** Confirm-button label for n checked rows. */
    label: (n: number) => string;
    confirm: (ids: number[]) => Promise<void>;
  };
  onClose: () => void;
}) {
  const [people, setPeople] = useState<PersonRow[] | null>(null);
  const [query, setQuery] = useState(initialQuery ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // similar_to re-ranks by centroid proximity: the stacks that LOOK like
    // this person lead the list — for a merge, the twin is usually first.
    const excluded = new Set([selfId, ...(excludeIds ?? [])]);
    fetchJson<{ people: PersonRow[] }>(`/api/people?similar_to=${selfId}`)
      .then((d) =>
        setPeople(d.people.filter((p) => !excluded.has(p.id) && !p.hidden)),
      )
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Failed to load"),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selfId, JSON.stringify(excludeIds ?? [])]);

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

  const toggleCheck = (id: number) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function confirmChecked() {
    if (!multi || checked.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      await multi.confirm([...checked]);
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
                className={`merge-row${checked.has(p.id) ? " is-checked" : ""}`}
                disabled={busy}
                onClick={() =>
                  // Once anything is ticked, rows toggle instead of merging —
                  // no accidental single merge mid-way through a multi pick.
                  multi && checked.size > 0 ? toggleCheck(p.id) : pick(p)
                }
              >
                <span
                  role="link"
                  tabIndex={0}
                  className="person-link"
                  title={`View ${p.name ?? "Unnamed"}'s profile`}
                  onClick={(e) => {
                    e.stopPropagation();
                    window.open(`/people/${p.id}`, "_blank", "noopener,noreferrer");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      window.open(`/people/${p.id}`, "_blank", "noopener,noreferrer");
                    }
                  }}
                >
                  <PersonAvatar coverFaceId={p.cover_face_id} name={p.name} />
                  <span className={`person-name${p.name ? "" : " person-unnamed"}`}>
                    {p.name ?? "Unnamed"}
                  </span>
                </span>
                {p.similarity != null && p.similarity > 0.3 && (
                  <span
                    className="pill merge-sim"
                    title="How closely this stack's average face matches this person"
                  >
                    {Math.round(p.similarity * 100)}% match
                  </span>
                )}
                <span className="pill person-count">
                  {p.asset_count.toLocaleString()} media
                </span>
                {multi && (
                  <span
                    className={`merge-check${checked.has(p.id) ? " active" : ""}`}
                    role="checkbox"
                    aria-checked={checked.has(p.id)}
                    aria-label={`Select ${p.name ?? "unnamed"} to fold into this stack`}
                    title="Tick several stacks to fold them ALL into this one"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!busy) toggleCheck(p.id);
                    }}
                  >
                    {Icons.pick}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
        <div className="modal-actions">
          {multi && checked.size > 0 && (
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void confirmChecked()}
            >
              {multi.label(checked.size)}
            </button>
          )}
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
