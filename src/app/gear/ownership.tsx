"use client";

// Whose camera is it — the /gear side of migration 0053 (cf. lib/gearOwners.ts).
//
// Three pieces, shared by every layout so the shelf says ownership the same way
// whichever of the eight is open:
//   OwnerMark    the mark before a body's name. Its SHAPE carries the answer —
//                a filled dot (mine), a ring with initials (someone else's), a
//                crossed ring (not a camera), a dashed ring (not sorted) — so it
//                reads without colour (vermillion stays the brand's, per the UI
//                review). Interactive, it opens the dialog; inside a link
//                (Blocks' tiles, Stack's flat chips) it is only a mark: a
//                button inside an <a> is not a control anyone can reach.
//   WhoseDialog  the one place an answer is given for one body: Mine (with the
//                span it was his), Someone else's (a person of /people, else a
//                typed name), Not a camera, Not sorted.
//   SortDeck     the first pass: the unsorted bodies one at a time, with four
//                of their frames to look at, one click each.
// The panel provides the context: the people to offer, and what to do once the
// server has answered (re-read nothing — the row it returns is applied in
// place, like every other write on the shelf).
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Spinner } from "../ui";
import { fetchJson } from "@/lib/fetchJson";
import type { GearOwner, GearOwnerKind, GearPerson } from "@/lib/gearTypes";
import { initials, ownerWords } from "@/lib/gearOwnerWords";
import type { KitBody } from "./model";

type Ctx = {
  people: GearPerson[];
  /** Open the dialog for one body; null when the shelf is read-only. */
  edit: ((body: KitBody) => void) | null;
};

const OwnershipContext = createContext<Ctx>({ people: [], edit: null });
export const OwnershipProvider = OwnershipContext.Provider;
export const useOwnership = () => useContext(OwnershipContext);

function MarkShape({ owner }: { owner: GearOwner | null }) {
  const kind = owner?.owner ?? "unsorted";
  return (
    <span className={`gear-mark is-${kind}`} aria-hidden="true">
      {kind === "other" ? initials(owner?.owner_name ?? null) : null}
    </span>
  );
}

/**
 * The mark before a body's name. `still` draws it without a control — for the
 * layouts that put the name inside a link.
 */
export function OwnerMark({ body, still = false }: { body: KitBody; still?: boolean }) {
  const { edit } = useOwnership();
  const words = ownerWords(body.owner);
  if (still || !edit)
    return (
      <span className="gear-owner" title={words}>
        <MarkShape owner={body.owner} />
        <span className="sr-only">{words}</span>
      </span>
    );
  return (
    <button
      type="button"
      className="gear-owner is-control"
      onClick={() => edit(body)}
      title={`${words} — change`}
      aria-label={`Whose camera is ${body.label}: ${words}. Change`}
    >
      <MarkShape owner={body.owner} />
    </button>
  );
}

/** The label of a body named by hand wears the display serif in italic — the
 *  same tell the Devices page and the viewer give it. */
export const namedClass = (body: KitBody) => (body.named ? " gear-named" : "");

// --------------------------------------------------------------- writes ----

export type OwnerAnswer = {
  owner: GearOwnerKind | null;
  person_id?: number | null;
  name?: string | null;
  from?: string | null;
  until?: string | null;
};

/** One body, one answer. Resolves to the stored owner (null: not sorted). */
export async function saveOwner(device: string, answer: OwnerAnswer): Promise<GearOwner | null> {
  const r = await fetchJson<{ owner: GearOwner | null }>("/api/gear/owners", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device, ...answer }),
  });
  return r.owner;
}

// --------------------------------------------------------------- dialog ----

/** Whose camera is this body — every answer, with the span and the person. */
export function WhoseDialog({
  body,
  people,
  onClose,
  onSaved,
}: {
  body: KitBody;
  people: GearPerson[];
  onClose: () => void;
  onSaved: (device: string, owner: GearOwner | null) => void;
}) {
  const o = body.owner;
  const [kind, setKind] = useState<GearOwnerKind | "unsorted">(o?.owner ?? "unsorted");
  const [from, setFrom] = useState(o?.owned_from ?? "");
  const [until, setUntil] = useState(o?.owned_until ?? "");
  const [personId, setPersonId] = useState<number | null>(o?.person_id ?? null);
  const [name, setName] = useState(o?.person_id ? "" : (o?.owner_name ?? ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const firstDay = body.from ? new Date(body.from).toISOString().slice(0, 10) : null;
  const lastDay = body.to ? new Date(body.to).toISOString().slice(0, 10) : null;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const owner = await saveOwner(
        body.name,
        kind === "unsorted"
          ? { owner: null }
          : kind === "mine"
            ? { owner: "mine", from: from || null, until: until || null }
            : kind === "other"
              ? { owner: "other", person_id: personId, name: personId ? null : name || null }
              : { owner: "none" },
      );
      onSaved(body.name, owner);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const choice = (k: GearOwnerKind | "unsorted", label: string, hint: string) => (
    <label className={`dev-pick-row${kind === k ? " is-on" : ""}`}>
      <input type="radio" name="gear-owner" checked={kind === k} onChange={() => setKind(k)} />
      <MarkShape
        owner={
          k === "unsorted"
            ? null
            : { owner: k, person_id: null, owner_name: null, owned_from: null, owned_until: null }
        }
      />
      <span className="dev-pick-name">{label}</span>
      <span className="dev-pick-raw">{hint}</span>
    </label>
  );

  return (
    <div className="modal-backdrop" onMouseDown={() => !busy && onClose()}>
      <form
        className="modal gear-whose"
        role="dialog"
        aria-modal="true"
        aria-label={`Whose camera is ${body.label}`}
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <h3 className="modal-title">
          Whose camera is <span className={namedClass(body)}>{body.label}</span>?
        </h3>
        <div className="modal-body">
          {error && (
            <p className="dev-pick-warn" role="alert">
              {error}
            </p>
          )}
          <div className="dev-pick-list" role="radiogroup" aria-label="Owner">
            {choice("mine", "Mine", "counts as “Shot by me”")}
            {choice("other", "Someone else’s", "a friend, a photographer")}
            {choice("none", "Not a camera", "an app, a webcam")}
            {choice("unsorted", "Not sorted", "decide later")}
          </div>

          {kind === "mine" && (
            <div className="gear-whose-more">
              <div className="gear-whose-dates">
                <label>
                  Mine from
                  <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
                </label>
                <label>
                  until
                  <input className="input" type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
                </label>
              </div>
              <p className="dev-pick-note">
                Leave either empty for “since the start” / “still mine”.
                {firstDay && lastDay ? ` Its media here run from ${firstDay} to ${lastDay}.` : ""}{" "}
                Frames outside the span count as someone else’s — the same camera, before you
                bought it or after you sold it.
              </p>
            </div>
          )}

          {kind === "other" && (
            <div className="gear-whose-more">
              {people.length > 0 && (
                <div className="chips">
                  {people.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className={`chip${personId === p.id ? " active" : ""}`}
                      aria-pressed={personId === p.id}
                      onClick={() => setPersonId(personId === p.id ? null : p.id)}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
              )}
              <input
                className="input"
                value={personId ? "" : name}
                disabled={personId != null}
                onChange={(e) => setName(e.target.value)}
                placeholder={people.length ? "…or a name: the wedding photographer" : "A name: Aymeric, the wedding photographer"}
                aria-label="Whose — a name"
                maxLength={120}
              />
              <p className="dev-pick-note">
                {people.length
                  ? "The people you named on /people, or any name. Empty: someone, unnamed."
                  : "Any name, or empty for someone unnamed."}
              </p>
            </div>
          )}
          <p className="dev-pick-note">
            Applies to the body: every medium it shot follows, in every grid. Nothing is written
            into the files.
          </p>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? <Spinner sm /> : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}

// ----------------------------------------------------------------- deck ----

/**
 * The first pass over the unsorted bodies: one at a time, four of its own
 * frames to look at, one click per answer. The span and the person can be
 * refined later from the mark; the deck is for getting through 20 bodies in a
 * minute, not for being thorough about one.
 */
export function SortDeck({
  queue,
  people,
  onClose,
  onSaved,
}: {
  queue: KitBody[];
  people: GearPerson[];
  onClose: () => void;
  onSaved: (device: string, owner: GearOwner | null) => void;
}) {
  // The queue is frozen when the deck opens: answering a body re-groups the
  // shelf underneath, and the deck must not lose its place when that happens.
  const frozen = useRef(queue).current;
  const [at, setAt] = useState(0);
  const [tally, setTally] = useState({ mine: 0, other: 0, none: 0, later: 0 });
  const [asking, setAsking] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [thumbs, setThumbs] = useState<{ id: number; ext: string }[] | null>(null);
  const body = frozen[at] ?? null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  // Four of its newest frames: the decision is taken looking AT them.
  useEffect(() => {
    if (!body) return;
    let live = true;
    setThumbs(null);
    fetchJson<{ assets: { id: number; ext: string }[] }>(
      `/api/assets?device=${encodeURIComponent(body.name)}&limit=4&collapse=1`,
    )
      .then((r) => live && setThumbs(r.assets.slice(0, 4)))
      .catch(() => live && setThumbs([]));
    return () => {
      live = false;
    };
  }, [body]);

  async function answer(key: keyof typeof tally, a: OwnerAnswer | null) {
    if (!body) return;
    setError(null);
    if (a) {
      setBusy(true);
      try {
        onSaved(body.name, await saveOwner(body.name, a));
      } catch (e) {
        setError((e as Error).message);
        setBusy(false);
        return;
      }
      setBusy(false);
    }
    setTally((t) => ({ ...t, [key]: t[key] + 1 }));
    setAsking(false);
    setName("");
    setAt((i) => i + 1);
  }

  const done = !body;
  const summary = useMemo(
    () =>
      [
        tally.mine && `${tally.mine} yours`,
        tally.other && `${tally.other} someone else’s`,
        tally.none && `${tally.none} not a camera`,
        tally.later && `${tally.later} left for later`,
      ]
        .filter(Boolean)
        .join(", ") || "Nothing answered",
    [tally],
  );

  return (
    <div className="modal-backdrop" onMouseDown={() => !busy && onClose()}>
      <div
        className="modal gear-deck"
        role="dialog"
        aria-modal="true"
        aria-label="Sort your kit"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="gear-deck-head">
          <h3 className="modal-title">Sort your kit</h3>
          <span className="hint">
            {done ? `${frozen.length} of ${frozen.length}` : `${at + 1} of ${frozen.length}`}
          </span>
          <span className="gear-deck-progress" aria-hidden="true">
            <i style={{ width: `${(Math.min(at, frozen.length) / Math.max(1, frozen.length)) * 100}%` }} />
          </span>
        </div>

        {done ? (
          <div className="modal-body">
            <p>{summary}.</p>
            <div className="modal-actions">
              <button type="button" className="btn btn-primary" onClick={onClose}>
                Back to the shelf
              </button>
            </div>
          </div>
        ) : (
          <div className="gear-deck-body">
            <div className="gear-deck-thumbs">
              {thumbs == null ? (
                <Spinner sm />
              ) : thumbs.length === 0 ? (
                <p className="hint">No frame to show.</p>
              ) : (
                thumbs.map((t) => (
                  <img
                    key={t.id}
                    src={`/api/assets/${t.id}/thumb`}
                    alt=""
                    loading="lazy"
                    onError={(e) => {
                      // No derivative yet: an empty tile, not a broken icon.
                      e.currentTarget.style.visibility = "hidden";
                    }}
                  />
                ))
              )}
            </div>
            <div className="gear-deck-side">
              <div>
                {/* "Unknown type" says nothing a deciding eye needs here. */}
                {body.kind !== "unknown" && <div className="hint">{body.kindLabel}</div>}
                <div className={`gear-deck-name${namedClass(body)}`}>{body.label}</div>
                {body.name !== body.label && <div className="dev-pick-raw">{body.name}</div>}
                <div className="hint">
                  {body.stats.count.toLocaleString("en-GB")} media{body.years ? ` · ${body.years}` : ""}
                  {body.named ? " · named by hand" : ""}
                </div>
              </div>
              {error && (
                <p className="dev-pick-warn" role="alert">
                  {error}
                </p>
              )}
              <div className="gear-deck-answers">
                <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void answer("mine", { owner: "mine" })}>
                  Mine
                </button>
                <button type="button" className="btn" disabled={busy} aria-expanded={asking} onClick={() => setAsking((v) => !v)}>
                  Someone else’s…
                </button>
                <button type="button" className="btn" disabled={busy} onClick={() => void answer("none", { owner: "none" })}>
                  Not a camera
                </button>
                <button type="button" className="btn" disabled={busy} onClick={() => void answer("later", null)}>
                  Decide later
                </button>
              </div>
              {asking && (
                <div className="gear-whose-more">
                  {people.length > 0 && (
                    <div className="chips">
                      {people.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          className="chip"
                          disabled={busy}
                          onClick={() => void answer("other", { owner: "other", person_id: p.id })}
                        >
                          {p.name}
                        </button>
                      ))}
                    </div>
                  )}
                  <form
                    className="gear-deck-name-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void answer("other", { owner: "other", name: name || null });
                    }}
                  >
                    <input
                      className="input"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="A name, or empty for someone"
                      aria-label="Whose — a name"
                      maxLength={120}
                      autoFocus
                    />
                    <button type="submit" className="btn" disabled={busy}>
                      Save
                    </button>
                  </form>
                </div>
              )}
              <p className="dev-pick-note">
                The span it was yours and the person can be refined later from its mark on the
                shelf.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
