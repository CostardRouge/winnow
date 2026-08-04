"use client";

// One person's page: who they are (rename in place), how they look (cover face
// picker over their best crops), what they appear in (the gallery's own
// VirtualGrid + MediaViewer over /api/assets?person=), and the escape hatches —
// open the same filter in the full gallery, or merge this stack into another
// person when the clusterer split someone in two (cf. lib/people.ts).
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { fetchJson } from "@/lib/fetchJson";
import { EmptyState, Icons, LoadingState } from "@/app/ui";
import MediaViewer from "@/app/MediaViewer";
import VirtualGrid, { type VirtualGridHandle } from "@/app/gallery/VirtualGrid";
import { PersonAvatar, type PersonRow } from "../PeoplePanel";
import type { AssetGridRow } from "@/lib/types";

type FaceRow = { id: number; asset_id: number; score: number };
type PersonResponse = { person: PersonRow; faces: FaceRow[] };
type AssetsPage = { assets: AssetGridRow[]; next_cursor: string | null };

const PAGE = 120;

/** Pick the stack's cover among the person's face crops, best detections
 *  first. The current cover wears a ring; picking closes the dialog. */
function CoverPicker({
  faces,
  current,
  onPick,
  onClose,
}: {
  faces: FaceRow[];
  current: number | null;
  onPick: (faceId: number) => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div
        className="modal modal-wide"
        role="dialog"
        aria-label="Choose the cover face"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title">Choose the cover face</h2>
        <div className="face-pick-grid">
          {faces.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`face-pick${f.id === current ? " active" : ""}`}
              onClick={() => onPick(f.id)}
              title={`Detection confidence ${(f.score * 100).toFixed(0)}%`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/faces/${f.id}/thumb`} alt="" loading="lazy" />
            </button>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/** Fold this stack into another person. The target keeps its name and cover
 *  (adopting this one's where it has none) and inherits every face. */
function MergePicker({
  selfId,
  onClose,
  onMerged,
}: {
  selfId: number;
  onClose: () => void;
  onMerged: (targetId: number) => void;
}) {
  const [people, setPeople] = useState<PersonRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchJson<{ people: PersonRow[] }>("/api/people")
      .then((d) => setPeople(d.people.filter((p) => p.id !== selfId)))
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Failed to load"),
      );
  }, [selfId]);

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
          Every face of this stack moves to the person you pick; they keep their
          name and cover. This stack disappears.
        </p>
        {error && (
          <div className="empty-state error" role="alert">
            {error}
          </div>
        )}
        {!people ? (
          <LoadingState label="Loading people…" />
        ) : people.length === 0 ? (
          <EmptyState title="Nobody to merge into" />
        ) : (
          <div className="merge-list">
            {people.map((p) => (
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

export default function PersonDetail({ personId }: { personId: number }) {
  const router = useRouter();
  const [person, setPerson] = useState<PersonRow | null>(null);
  const [faces, setFaces] = useState<FaceRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [items, setItems] = useState<AssetGridRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);

  const [viewer, setViewer] = useState<number | null>(null);
  const [coverOpen, setCoverOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);

  const [editingName, setEditingName] = useState(false);
  const [draft, setDraft] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<VirtualGridHandle>(null);

  useEffect(() => {
    if (!Number.isFinite(personId)) {
      setLoadError("Invalid person id");
      return;
    }
    fetchJson<PersonResponse>(`/api/people/${personId}`)
      .then((d) => {
        setPerson(d.person);
        setFaces(d.faces);
      })
      .catch((e: unknown) =>
        setLoadError(e instanceof Error ? e.message : "Failed to load"),
      );
  }, [personId]);

  // The media grid: same keyset pagination as the gallery, scoped to this
  // person (collapse=1 so pairs and bursts show as one tile, like everywhere).
  // First page keyed on personId (a merge navigates here with a NEW id, so the
  // grid must reset rather than append across people); VirtualGrid drives the
  // following pages through loadMore.
  useEffect(() => {
    if (!Number.isFinite(personId)) return;
    let alive = true;
    setItems([]);
    setCursor(null);
    setHasMore(true);
    setViewer(null);
    setLoading(true);
    fetchJson<AssetsPage>(
      `/api/assets?person=${personId}&collapse=1&sort_dir=desc&limit=${PAGE}`,
    )
      .then((d) => {
        if (!alive) return;
        setItems(d.assets);
        setCursor(d.next_cursor);
        setHasMore(Boolean(d.next_cursor));
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setLoadError(e instanceof Error ? e.message : "Failed to load media");
        setHasMore(false);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [personId]);

  const loadMore = useCallback(async () => {
    if (loading || !hasMore || !cursor) return;
    setLoading(true);
    try {
      const d = await fetchJson<AssetsPage>(
        `/api/assets?person=${personId}&collapse=1&sort_dir=desc&limit=${PAGE}&cursor=${encodeURIComponent(cursor)}`,
      );
      setItems((prev) => [...prev, ...d.assets]);
      setCursor(d.next_cursor);
      setHasMore(Boolean(d.next_cursor));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load media");
      setHasMore(false);
    } finally {
      setLoading(false);
    }
  }, [personId, cursor, hasMore, loading]);

  useEffect(() => {
    if (editingName) nameRef.current?.select();
  }, [editingName]);

  async function saveName() {
    if (!person) return;
    const name = draft.trim() || null;
    try {
      await fetchJson(`/api/people/${person.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      setPerson({ ...person, name });
      setEditingName(false);
    } catch {
      /* keep the input open to retry or Esc out */
    }
  }

  async function pickCover(faceId: number) {
    if (!person) return;
    try {
      await fetchJson(`/api/people/${person.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cover_face_id: faceId }),
      });
      setPerson({ ...person, cover_face_id: faceId });
      setCoverOpen(false);
    } catch {
      setCoverOpen(false);
    }
  }

  if (loadError) {
    return (
      <div className="app-shell">
        <div className="topbar">
          <h1>People</h1>
        </div>
        <EmptyState icon={Icons.alert} title="Person not found" hint={loadError}>
          <Link className="btn" href="/people">
            Back to People
          </Link>
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <div className="topbar">
        <h1>People</h1>
        <span className="hint max-sm:hidden">one stack, all their media</span>
      </div>

      {!person ? (
        <LoadingState label="Loading person…" />
      ) : (
        <>
          <div className="shell-head person-head">
            <PersonAvatar
              coverFaceId={person.cover_face_id}
              name={person.name}
              size="lg"
            />
            <div className="person-head-id">
              {editingName ? (
                <input
                  ref={nameRef}
                  className="input person-name-input"
                  value={draft}
                  placeholder="Name this person…"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void saveName();
                    if (e.key === "Escape") setEditingName(false);
                  }}
                  onBlur={() => setEditingName(false)}
                />
              ) : (
                <button
                  type="button"
                  className="person-head-name"
                  title={person.name ? "Rename" : "Name this person"}
                  onClick={() => {
                    setDraft(person.name ?? "");
                    setEditingName(true);
                  }}
                >
                  <span className={person.name ? "" : "person-unnamed"}>
                    {person.name ?? "Unnamed"}
                  </span>
                  <span className="person-head-pencil" aria-hidden>
                    {Icons.pencil}
                  </span>
                </button>
              )}
              <span className="hint">
                {person.asset_count.toLocaleString()}{" "}
                {person.asset_count === 1 ? "media" : "media"} ·{" "}
                {person.face_count.toLocaleString()}{" "}
                {person.face_count === 1 ? "face" : "faces"}
              </span>
            </div>
            <span className="spacer" />
            <div className="person-head-actions">
              <button
                className="btn"
                onClick={() => setCoverOpen(true)}
                disabled={faces.length === 0}
              >
                Choose cover
              </button>
              <button className="btn" onClick={() => setMergeOpen(true)}>
                Merge into…
              </button>
              <Link
                className="btn"
                href={`/library/gallery?person=${person.id}`}
                title="The same filter, in the full gallery (combine with any other filter there)"
              >
                Open in gallery
              </Link>
            </div>
          </div>

          <div className="ml-search-body">
            {items.length === 0 && !loading && !hasMore ? (
              <EmptyState
                icon={Icons.people}
                title="No media"
                hint="Every media this person appeared in has been trashed."
              />
            ) : (
              <VirtualGrid
                ref={gridRef}
                items={items}
                hasMore={hasMore}
                loading={loading}
                loadMore={() => void loadMore()}
                onOpen={setViewer}
              />
            )}
          </div>

          {viewer != null && items[viewer] && (
            <MediaViewer
              items={items}
              index={viewer}
              onIndexChange={setViewer}
              onClose={() => {
                gridRef.current?.scrollToIndex(viewer);
                setViewer(null);
              }}
              renderActions={(it) => (
                <>
                  <Link
                    className="btn"
                    href={`/sessions/${it.session_id}`}
                    title="Open the session this media belongs to"
                  >
                    Open session
                  </Link>
                  <a className="btn" href={`/api/assets/${it.id}/download`} download>
                    Download
                  </a>
                </>
              )}
            />
          )}

          {coverOpen && (
            <CoverPicker
              faces={faces}
              current={person.cover_face_id}
              onPick={(id) => void pickCover(id)}
              onClose={() => setCoverOpen(false)}
            />
          )}
          {mergeOpen && (
            <MergePicker
              selfId={person.id}
              onClose={() => setMergeOpen(false)}
              onMerged={(targetId) => router.replace(`/people/${targetId}`)}
            />
          )}
        </>
      )}
    </div>
  );
}
