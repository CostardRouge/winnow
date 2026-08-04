"use client";

// The /people shelf: one card per clustered person (cf. lib/people.ts), fronted
// by their cover face crop, named people first, then busiest first. Tapping a
// card opens the person's detail page; the pencil beside the name renames in
// place; the ⋯ menu on the card corner carries the rest (merge, gallery).
//
// The segmented tabs (All / Named / Unnamed) split the shelf the way the
// Library splits Incoming/Gallery: naming is the actual WORK this page hosts,
// and "which stacks still need a name" is the question the Unnamed tab answers.
//
// Noise control: the clusterer inevitably mints tiny "people" — background
// strangers, one-off detections. Unnamed stacks below the ML_PERSON_MIN_FACES
// threshold hide behind a "Show all" toggle (named people always show: a name
// is a user's claim that the stack matters).
//
// Renaming a stack to a name ANOTHER stack already carries almost always means
// the clusterer split one person — so the rename immediately offers the merge,
// with the list pre-searched on that name.
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { fetchJson } from "@/lib/fetchJson";
import { normalizeName } from "@/lib/nameMatch";
import { EmptyState, Icons, LoadingState } from "@/app/ui";
import PersonPicker from "./PersonPicker";
import SuggestionsModal, { type MergeSuggestion } from "./SuggestionsModal";

export type PersonRow = {
  id: number;
  name: string | null;
  hidden: boolean;
  face_count: number;
  asset_count: number;
  cover_face_id: number | null;
  // Centroid cosine vs the `similar_to` person — only on picker fetches
  // (GET /api/people?similar_to=), absent from the plain list.
  similarity?: number;
};

type PeopleResponse = {
  people: PersonRow[];
  minFaces: number;
  facesEnabled: boolean;
  unassigned: number;
};

type Tab = "all" | "named" | "unnamed" | "hidden";

const TABS: { key: Tab; label: string; title: string }[] = [
  { key: "all", label: "All", title: "Every person" },
  { key: "named", label: "Named", title: "People you have named" },
  { key: "unnamed", label: "Unnamed", title: "Stacks still waiting for a name" },
  { key: "hidden", label: "Hidden", title: "Stacks you tucked away" },
];

const num = (n: number) => n.toLocaleString();

// Same order the API serves (named first, then busiest): re-applied locally so
// a just-renamed card settles into its new place without a refetch.
function byNamedThenCount(a: PersonRow, b: PersonRow): number {
  return (
    Number(b.name != null) - Number(a.name != null) ||
    b.asset_count - a.asset_count ||
    (a.name ?? "").localeCompare(b.name ?? "") ||
    a.id - b.id
  );
}

/** The circular face crop fronting a stack — or a silhouette when the person
 *  has no live face to crop (possible mid-re-analysis). */
export function PersonAvatar({
  coverFaceId,
  name,
  size = "md",
}: {
  coverFaceId: number | null;
  name: string | null;
  size?: "md" | "lg";
}) {
  return (
    <span className={`person-avatar person-avatar-${size}`}>
      {coverFaceId != null ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/faces/${coverFaceId}/thumb`}
          alt={name ?? "Unnamed person"}
          loading="lazy"
        />
      ) : (
        <span className="person-avatar-fallback" aria-hidden>
          {Icons.people}
        </span>
      )}
    </span>
  );
}

/** One stack. The name line carries its own pencil (renaming is THE action
 *  here); the ⋯ button opens the rest — merge, open in gallery. */
function PersonCard({
  person,
  onRenamed,
  onMergeRequest,
  onToggleHidden,
}: {
  person: PersonRow;
  onRenamed: (id: number, name: string | null) => void;
  onMergeRequest: (person: PersonRow) => void;
  onToggleHidden: (person: PersonRow) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(person.name ?? "");
  const [saving, setSaving] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  // The ⋯ menu closes on any click outside its card.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  async function save() {
    const name = draft.trim() || null;
    setSaving(true);
    try {
      await fetchJson(`/api/people/${person.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      onRenamed(person.id, name);
      setEditing(false);
    } catch {
      // Keep the input open — the draft is still there to retry or Esc out of.
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="person-card-wrap" ref={wrapRef}>
      <Link href={`/people/${person.id}`} className="person-card">
        <PersonAvatar coverFaceId={person.cover_face_id} name={person.name} />
        {!editing && (
          <span className="person-name-row">
            <span className={`person-name${person.name ? "" : " person-unnamed"}`}>
              {person.name ?? "Unnamed"}
            </span>
            <button
              type="button"
              className="person-rename"
              title={person.name ? "Rename" : "Name this person"}
              aria-label={`Rename ${person.name ?? "unnamed person"}`}
              onClick={(e) => {
                // The pencil sits inside the card link: renaming must not
                // navigate.
                e.preventDefault();
                e.stopPropagation();
                setDraft(person.name ?? "");
                setEditing(true);
              }}
            >
              {Icons.pencil}
            </button>
          </span>
        )}
        <span className="pill person-count">{num(person.asset_count)} media</span>
      </Link>
      {editing && (
        <input
          ref={inputRef}
          className="input person-name-input"
          value={draft}
          disabled={saving}
          placeholder="Name this person…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
            if (e.key === "Escape") setEditing(false);
          }}
          onBlur={() => setEditing(false)}
        />
      )}
      <button
        type="button"
        className="person-more"
        title="More actions"
        aria-label={`Actions for ${person.name ?? "unnamed person"}`}
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((v) => !v)}
      >
        {Icons.more}
      </button>
      {menuOpen && (
        <div className="person-menu" role="menu">
          <button
            type="button"
            className="person-menu-item"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              setDraft(person.name ?? "");
              setEditing(true);
            }}
          >
            <span className="person-menu-ic" aria-hidden>
              {Icons.pencil}
            </span>
            {person.name ? "Rename" : "Name…"}
          </button>
          <button
            type="button"
            className="person-menu-item"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              onMergeRequest(person);
            }}
          >
            <span className="person-menu-ic" aria-hidden>
              {Icons.people}
            </span>
            Merge into…
          </button>
          <button
            type="button"
            className="person-menu-item"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              onToggleHidden(person);
            }}
          >
            <span className="person-menu-ic" aria-hidden>
              {person.hidden ? Icons.view : Icons.close}
            </span>
            {person.hidden ? "Unhide" : "Hide"}
          </button>
          <Link
            href={`/library/gallery?person=${person.id}`}
            className="person-menu-item"
            role="menuitem"
            onClick={() => setMenuOpen(false)}
          >
            <span className="person-menu-ic" aria-hidden>
              {Icons.photos}
            </span>
            Open in gallery
          </Link>
        </div>
      )}
    </div>
  );
}

export default function PeoplePanel() {
  const [data, setData] = useState<PeopleResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("all");
  const [showAll, setShowAll] = useState(false);
  // Free-text name search. A match beats the small-stack threshold: someone
  // typing a name is looking for a specific person, not browsing.
  const [query, setQuery] = useState("");
  // The one-click backfill (library analyzed before People existed): idle →
  // queued (the worker sweeps in the background; a reload shows the result).
  const [grouping, setGrouping] = useState<"idle" | "queued" | "error">("idle");
  // The merge dialog: which stack is being folded away, and — in the
  // duplicate-name rename flow — the name to pre-search the candidates with.
  const [merging, setMerging] = useState<{
    person: PersonRow;
    initialQuery?: string;
    hint?: string;
  } | null>(null);

  // Merge suggestions (near-identical stacks, cf. lib/people.suggestMerges):
  // best-effort — a failed fetch just means no banner.
  const [suggestions, setSuggestions] = useState<MergeSuggestion[]>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);

  const load = () =>
    Promise.all([
      fetchJson<PeopleResponse>("/api/people").then(setData),
      fetchJson<{ suggestions: MergeSuggestion[] }>("/api/people/suggestions")
        .then((d) => setSuggestions(d.suggestions))
        .catch(() => {}),
    ]).catch((e: unknown) =>
      setError(e instanceof Error ? e.message : "Failed to load"),
    );

  useEffect(() => {
    void load();
  }, []);

  // A rename settles the card into its new order locally — and when the new
  // name already fronts ANOTHER stack, offers to merge into it right away.
  // The twin comparison is accent/case-insensitive (cf. lib/nameMatch), so
  // naming a stack "Chloe" still finds the existing "Chloé".
  const rename = (id: number, name: string | null) => {
    setData((d) =>
      d
        ? {
            ...d,
            people: d.people
              .map((p) => (p.id === id ? { ...p, name } : p))
              .sort(byNamedThenCount),
          }
        : d,
    );
    if (!name || !data) return;
    const self = data.people.find((p) => p.id === id);
    const twin = data.people.find(
      (p) =>
        p.id !== id &&
        p.name != null &&
        normalizeName(p.name) === normalizeName(name),
    );
    if (self && twin) {
      setMerging({
        person: { ...self, name },
        initialQuery: name,
        hint: `Another stack is already named “${twin.name}” — same person? Merging moves every face of this stack over there.`,
      });
    }
  };

  // Hide/unhide from the card menu: instant local flip (the card leaves the
  // current tab on its own — hidden people only live on the Hidden tab).
  const toggleHidden = (person: PersonRow) => {
    const hidden = !person.hidden;
    setData((d) =>
      d
        ? {
            ...d,
            people: d.people.map((p) =>
              p.id === person.id ? { ...p, hidden } : p,
            ),
          }
        : d,
    );
    fetchJson(`/api/people/${person.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hidden }),
    }).catch(() => {
      // Roll the optimistic flip back — the server didn't take it.
      setData((d) =>
        d
          ? {
              ...d,
              people: d.people.map((p) =>
                p.id === person.id ? { ...p, hidden: !hidden } : p,
              ),
            }
          : d,
      );
    });
  };

  const grouped = useMemo(() => {
    const people = data?.people ?? [];
    const minFaces = data?.minFaces ?? 1;
    // Accent/case-insensitive search (cf. lib/nameMatch): "chloe" → "Chloé".
    const q = normalizeName(query);
    const inTab = people.filter(
      (p) =>
        (tab === "hidden"
          ? p.hidden
          : !p.hidden &&
            (tab === "named"
              ? p.name != null
              : tab === "unnamed"
                ? p.name == null
                : true)) &&
        (!q || normalizeName(p.name ?? "unnamed").includes(q)),
    );
    // Named people always show; unnamed ones must clear the face threshold
    // unless the toggle is on — or a search is running (a searched person must
    // never hide). The Named tab has nothing to tuck away by definition.
    const visible = q
      ? inTab
      : inTab.filter((p) => p.name != null || p.face_count >= minFaces);
    return { inTab, visible, hidden: inTab.length - visible.length };
  }, [data, tab, query]);

  async function groupNow() {
    try {
      await fetchJson("/api/pipeline/people-backfill", { method: "POST" });
      setGrouping("queued");
    } catch {
      setGrouping("error");
    }
  }

  if (error) {
    return (
      <div className="empty-state error" role="alert">
        {error}
      </div>
    );
  }
  if (!data) return <LoadingState label="Gathering the faces…" />;

  if (!data.facesEnabled && data.people.length === 0) {
    return (
      <EmptyState
        icon={Icons.people}
        title="Face detection is off"
        hint="People appear here once the ML analysis runs over the library. Set ML_ENABLED=true and ML_FACES_ENABLED=true with ML_BASE_URL pointing at your immich-machine-learning container."
      />
    );
  }

  if (data.people.length === 0) {
    return (
      <EmptyState
        icon={Icons.people}
        title="No people yet"
        hint={
          data.unassigned > 0
            ? `${num(data.unassigned)} detected face(s) are waiting to be grouped into people.`
            : "Faces appear here as the ML analysis works through the library — people are grouped automatically as they are detected."
        }
      >
        {data.unassigned > 0 &&
          (grouping === "queued" ? (
            <span className="hint">
              Grouping queued — the worker is sweeping the library. Reload in a
              moment.
            </span>
          ) : (
            <button className="btn btn-primary" onClick={groupNow}>
              Group into people
            </button>
          ))}
        {grouping === "error" && (
          <span className="hint">
            Could not queue the grouping (admin required?).
          </span>
        )}
      </EmptyState>
    );
  }

  const shown = showAll ? grouped.inTab : grouped.visible;
  const totalAssets = data.people.reduce((s, p) => s + p.asset_count, 0);

  return (
    <div className="people-shelf">
      <div className="gear-head">
        <div className="tabs" role="group" aria-label="Which people">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={`tab${tab === t.key ? " active" : ""}`}
              onClick={() => setTab(t.key)}
              aria-pressed={tab === t.key}
              title={t.title}
            >
              {t.label}
            </button>
          ))}
        </div>
        <span className="hint">
          {num(data.people.length)}{" "}
          {data.people.length === 1 ? "person" : "people"} · {num(totalAssets)}{" "}
          media
          {data.unassigned > 0 && (
            <>
              {" · "}
              {grouping === "queued" ? (
                <span>{num(data.unassigned)} faces queued for grouping</span>
              ) : (
                <button className="link-btn" onClick={groupNow}>
                  group {num(data.unassigned)} new faces
                </button>
              )}
            </>
          )}
        </span>
        <span className="spacer" />
        <div className="search-field people-search">
          <span className="search-icon" aria-hidden>
            {Icons.search}
          </span>
          <input
            className="input search-input"
            type="search"
            placeholder="Search people…"
            aria-label="Search people by name"
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
        {grouped.hidden > 0 && (
          <button
            className={`view-btn${showAll ? " active" : ""}`}
            onClick={() => setShowAll((v) => !v)}
            aria-pressed={showAll}
            title="Unnamed people seen on only a few faces (background strangers) are tucked away by default"
          >
            {showAll ? "Hide small stacks" : `Show all (${num(grouped.hidden)} more)`}
          </button>
        )}
      </div>

      {suggestions.length > 0 && (
        // Proposed, never automatic: the banner counts the near-identical
        // pairs and the modal walks them one merge (or dismissal) at a time.
        <div className="suggest-banner">
          <span className="hint">
            {num(suggestions.length)}{" "}
            {suggestions.length === 1 ? "pair" : "pairs"} of stacks look like
            the same person.
          </span>
          <button className="btn" onClick={() => setSuggestOpen(true)}>
            Review
          </button>
        </div>
      )}

      {shown.length === 0 ? (
        <EmptyState
          icon={Icons.people}
          title={
            query.trim()
              ? "No matching person"
              : tab === "named"
                ? "Nobody named yet"
                : "Nothing here"
          }
          hint={
            query.trim()
              ? "Try fewer letters — unnamed stacks match “unnamed”."
              : tab === "named"
                ? "Use the pencil on a card to put a name on a stack."
                : tab === "hidden"
                  ? "Hide a stack from its card's ⋯ menu — it moves here."
                  : grouped.inTab.length > 0
                    ? "Every stack here is below the small-stack threshold — use “Show all”."
                    : "Try another tab."
          }
        />
      ) : (
        <div className="people-grid">
          {shown.map((p) => (
            <PersonCard
              key={p.id}
              person={p}
              onRenamed={rename}
              onMergeRequest={(person) => setMerging({ person })}
              onToggleHidden={toggleHidden}
            />
          ))}
        </div>
      )}

      {suggestOpen && data && (
        <SuggestionsModal
          suggestions={suggestions}
          people={data.people}
          onClose={() => setSuggestOpen(false)}
          onMerged={() => void load()}
        />
      )}

      {merging && (
        <PersonPicker
          selfId={merging.person.id}
          title="Merge into…"
          hint={
            merging.hint ??
            "Every face of this stack moves to the person you pick; they keep their name and cover. This stack disappears."
          }
          initialQuery={merging.initialQuery}
          onClose={() => setMerging(null)}
          confirm={async (target) => {
            if (!target) return;
            await fetchJson(`/api/people/${target.id}/merge`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ source_id: merging.person.id }),
            });
            // The folded stack is gone and the target's counts changed: the
            // server list is the truth now.
            setMerging(null);
            void load();
          }}
        />
      )}
    </div>
  );
}
