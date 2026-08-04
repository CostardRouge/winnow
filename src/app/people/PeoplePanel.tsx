"use client";

// The /people shelf: one card per clustered person (cf. lib/people.ts), fronted
// by their cover face crop, named or "Unnamed", sorted by how often they appear.
// Tapping a card opens the person's detail page (their media + rename + cover +
// merge); the pencil renames in place without leaving the shelf.
//
// Noise control: the clusterer inevitably mints tiny "people" — background
// strangers, one-off detections. Unnamed stacks below the ML_PERSON_MIN_FACES
// threshold hide behind a "Show all" toggle (named people always show: a name
// is a user's claim that the stack matters).
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { fetchJson } from "@/lib/fetchJson";
import { EmptyState, Icons, LoadingState } from "@/app/ui";

export type PersonRow = {
  id: number;
  name: string | null;
  face_count: number;
  asset_count: number;
  cover_face_id: number | null;
};

type PeopleResponse = {
  people: PersonRow[];
  minFaces: number;
  facesEnabled: boolean;
  unassigned: number;
};

const num = (n: number) => n.toLocaleString();

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

/** One stack. The pencil swaps the name line for an input in place — naming a
 *  face should not cost a navigation. */
function PersonCard({
  person,
  onRenamed,
}: {
  person: PersonRow;
  onRenamed: (id: number, name: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(person.name ?? "");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

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
    <div className="person-card-wrap">
      <Link href={`/people/${person.id}`} className="person-card">
        <PersonAvatar coverFaceId={person.cover_face_id} name={person.name} />
        {!editing && (
          <span className={`person-name${person.name ? "" : " person-unnamed"}`}>
            {person.name ?? "Unnamed"}
          </span>
        )}
        <span className="pill person-count">
          {num(person.asset_count)} {person.asset_count === 1 ? "media" : "media"}
        </span>
      </Link>
      {editing ? (
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
      ) : (
        <button
          type="button"
          className="person-rename"
          title={person.name ? "Rename" : "Name this person"}
          aria-label={`Rename ${person.name ?? "unnamed person"}`}
          onClick={() => {
            setDraft(person.name ?? "");
            setEditing(true);
          }}
        >
          {Icons.pencil}
        </button>
      )}
    </div>
  );
}

export default function PeoplePanel() {
  const [data, setData] = useState<PeopleResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  // The one-click backfill (library analyzed before People existed): idle →
  // queued (the worker sweeps in the background; a reload shows the result).
  const [grouping, setGrouping] = useState<"idle" | "queued" | "error">("idle");

  useEffect(() => {
    fetchJson<PeopleResponse>("/api/people")
      .then(setData)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Failed to load"),
      );
  }, []);

  const rename = (id: number, name: string | null) =>
    setData((d) =>
      d
        ? {
            ...d,
            people: d.people.map((p) => (p.id === id ? { ...p, name } : p)),
          }
        : d,
    );

  // Named people always show; unnamed ones must clear the face threshold
  // unless the toggle is on.
  const { visible, hidden } = useMemo(() => {
    const people = data?.people ?? [];
    const minFaces = data?.minFaces ?? 1;
    const visible = people.filter(
      (p) => p.name != null || p.face_count >= minFaces,
    );
    return { visible, hidden: people.length - visible.length };
  }, [data]);

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

  const shown = showAll ? data.people : visible;
  const totalAssets = data.people.reduce((s, p) => s + p.asset_count, 0);

  return (
    <div className="people-shelf">
      <div className="gear-head">
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
        {hidden > 0 && (
          <button
            className={`view-btn${showAll ? " active" : ""}`}
            onClick={() => setShowAll((v) => !v)}
            aria-pressed={showAll}
            title="Unnamed people seen on only a few faces (background strangers) are tucked away by default"
          >
            {showAll ? "Hide small stacks" : `Show all (${num(hidden)} more)`}
          </button>
        )}
      </div>

      <div className="people-grid">
        {shown.map((p) => (
          <PersonCard key={p.id} person={p} onRenamed={rename} />
        ))}
      </div>
    </div>
  );
}
