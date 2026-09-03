"use client";

// Rename / locate / split / merge one timeline chapter.
//
// Every gesture here writes a CORRECTION on top of the derivation (cf.
// migration 0040, lib/timeline.ts) — a named span or a forced break — never
// a chapter. So the dialog is small: a name, a location, a day to cut at, a
// neighbour to merge with, and the undo of each. Nothing in it touches an
// asset: the chapter's location is the chapter's, and placing the chapter's
// GPS-less media there is a separate, explicit gesture (cf.
// docs/memory/architecture.md, "A deduced location never writes into an
// original").
import { useEffect, useMemo, useRef, useState } from "react";
import { fetchJson } from "@/lib/fetchJson";
import type { TimelineChapter } from "@/lib/timeline";
import type { PlaceSuggestion } from "@/lib/geocode";
import { Spinner } from "@/app/ui";
import { useOverlayDismiss } from "@/app/useOverlayDismiss";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const DAYS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const MONTHS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

type Place = { label: string; lat: number; lon: number } | null;

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** The chapter's local days after its first: the instants a split can start
 *  at. A day starts at local midnight, which is UTC midnight minus the
 *  chapter's offset — the same arithmetic ChapterCard reads days with. */
function splitDays(ch: TimelineChapter) {
  const off = (ch.tz_offset_hours ?? 0) * HOUR_MS;
  const first = new Date(Date.parse(ch.started_at) + off);
  const last = new Date(Date.parse(ch.ended_at) + off);
  const out: { at: string; label: string }[] = [];
  let d = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate()) + DAY_MS;
  const end = Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), last.getUTCDate());
  for (; d <= end; d += DAY_MS) {
    const l = new Date(d);
    out.push({
      at: new Date(d - off).toISOString(),
      label: `${DAYS[l.getUTCDay()]} ${l.getUTCDate()} ${MONTHS[l.getUTCMonth()]}`,
    });
  }
  return out;
}

export default function ChapterEditModal({
  chapter: ch,
  prev,
  next,
  onClose,
  onChanged,
}: {
  chapter: TimelineChapter;
  /** Neighbours in the current stream, for "merge with". */
  prev: TimelineChapter | null;
  next: TimelineChapter | null;
  onClose: () => void;
  /** Something was written: the host re-derives the stream. */
  onChanged: () => void;
}) {
  const backdrop = useOverlayDismiss<HTMLDivElement>(() => {
    if (!busy) onClose();
  });

  const [name, setName] = useState(ch.name);
  const [place, setPlace] = useState<Place>(
    ch.place_label && ch.place_lat != null && ch.place_lon != null
      ? { label: ch.place_label, lat: ch.place_lat, lon: ch.place_lon }
      : null,
  );
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const [splitAt, setSplitAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);

  // Forward geocode on a debounced keystroke, through the server-side proxy
  // (the browser never talks to Nominatim; the shared rate budget applies).
  useEffect(() => {
    const q = query.trim();
    if (q.length < 3) {
      setSuggestions([]);
      return;
    }
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const d = await fetchJson<{ results: PlaceSuggestion[] }>(
          `/api/places/search?q=${encodeURIComponent(q)}`,
        );
        setSuggestions(d.results);
      } catch {
        setSuggestions([]);
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [query]);

  const days = useMemo(() => splitDays(ch), [ch]);

  const nameChanged = name.trim() !== ch.name;
  const placeChanged =
    (place?.label ?? null) !== (ch.place_label ?? null) ||
    (place?.lat ?? null) !== (ch.place_lat ?? null);
  const dirty = nameChanged || placeChanged;

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
      onChanged();
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const check = async (r: Response) => {
    if (r.ok) return;
    let msg = `HTTP ${r.status}`;
    try {
      const b = await r.json();
      if (typeof b.error === "string") msg = b.error;
    } catch {
      /* keep the status */
    }
    throw new Error(msg);
  };

  const spanFields = () => ({
    name: name.trim() || null,
    place_label: place?.label ?? null,
    place_lat: place?.lat ?? null,
    place_lon: place?.lon ?? null,
  });

  // Save = PATCH the existing span, or draw one over the derived chapter.
  const save = () =>
    run(async () => {
      const r = ch.override_id
        ? await fetch(`/api/timeline/chapters/${ch.override_id}`, jsonInit("PATCH", spanFields()))
        : await fetch(
            "/api/timeline/chapters",
            jsonInit("POST", { starts_at: ch.started_at, ends_at: ch.ended_at, ...spanFields() }),
          );
      await check(r);
    });

  const split = () =>
    run(async () => {
      await check(await fetch("/api/timeline/breaks", jsonInit("POST", { at: splitAt })));
    });

  // Merge = one span over both ranges, keeping this chapter's name. Any span
  // either side already owns is dropped first, since spans may not overlap.
  const merge = (other: TimelineChapter) =>
    run(async () => {
      for (const id of [ch.override_id, other.override_id]) {
        if (id) await check(await fetch(`/api/timeline/chapters/${id}`, { method: "DELETE" }));
      }
      const lo = ch.started_at < other.started_at ? ch : other;
      const hi = lo === ch ? other : ch;
      await check(
        await fetch(
          "/api/timeline/chapters",
          jsonInit("POST", { starts_at: lo.started_at, ends_at: hi.ended_at, ...spanFields() }),
        ),
      );
    });

  const reset = () =>
    run(async () => {
      await check(await fetch(`/api/timeline/chapters/${ch.override_id}`, { method: "DELETE" }));
    });

  const unsplit = () =>
    run(async () => {
      await check(await fetch(`/api/timeline/breaks/${ch.break_id}`, { method: "DELETE" }));
    });

  return (
    <div className="modal-overlay" role="presentation" {...backdrop}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="tl-edit-title">
        <h2 className="modal-title" id="tl-edit-title">
          {ch.override_id ? "Modifier le chapitre" : "Nommer le chapitre"}
        </h2>
        <p className="hint">
          {ch.count.toLocaleString()} médias · {ch.sessions.length} dossier
          {ch.sessions.length > 1 ? "s" : ""}. Une correction posée sur le découpage, jamais une
          copie des médias : ré-indexer n'y change rien.
        </p>

        <label className="modal-label" htmlFor="tl-edit-name">
          Nom
        </label>
        <input
          ref={nameRef}
          id="tl-edit-name"
          className="input modal-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={ch.places[0] ?? "Lieu inconnu"}
          maxLength={120}
          disabled={busy}
        />

        <label className="modal-label" htmlFor="tl-edit-place">
          Lieu du chapitre
        </label>
        {place ? (
          <div className="tl-edit-place">
            <span className="chip active" title={`${place.lat.toFixed(4)}, ${place.lon.toFixed(4)}`}>
              {place.label}
              <button
                type="button"
                className="chip-x"
                aria-label="Retirer le lieu"
                onClick={() => setPlace(null)}
                disabled={busy}
              >
                ×
              </button>
            </span>
          </div>
        ) : (
          <>
            <input
              id="tl-edit-place"
              className="input modal-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Rechercher une ville, un lieu…"
              autoComplete="off"
              disabled={busy}
            />
            {(searching || suggestions.length > 0) && (
              <ul className="tl-edit-suggest" role="listbox">
                {searching && (
                  <li className="hint">
                    <Spinner sm /> recherche…
                  </li>
                )}
                {suggestions.map((s) => (
                  <li key={`${s.lat},${s.lon}`}>
                    <button
                      type="button"
                      onClick={() => {
                        setPlace({ label: s.display_name, lat: s.lat, lon: s.lon });
                        setQuery("");
                        setSuggestions([]);
                      }}
                    >
                      {s.display_name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="hint" style={{ marginTop: 6 }}>
              Décrit le chapitre, pas les médias : leur position n'est pas modifiée.
            </p>
          </>
        )}

        {days.length > 0 && (
          <>
            <label className="modal-label" htmlFor="tl-edit-split">
              Scinder au matin du
            </label>
            <div className="tl-edit-row">
              <select
                id="tl-edit-split"
                className="input modal-input"
                value={splitAt}
                onChange={(e) => setSplitAt(e.target.value)}
                disabled={busy}
              >
                <option value="">— choisir un jour —</option>
                {days.map((d) => (
                  <option key={d.at} value={d.at}>
                    {d.label}
                  </option>
                ))}
              </select>
              <button className="btn" onClick={split} disabled={busy || !splitAt}>
                Scinder
              </button>
            </div>
          </>
        )}

        {(prev || next) && (
          <>
            <span className="modal-label">Fusionner</span>
            <div className="tl-edit-row">
              {prev && (
                <button className="btn" onClick={() => merge(prev)} disabled={busy} title={prev.name}>
                  ← avec « {prev.name} »
                </button>
              )}
              {next && (
                <button className="btn" onClick={() => merge(next)} disabled={busy} title={next.name}>
                  avec « {next.name} » →
                </button>
              )}
            </div>
          </>
        )}

        {error && <p className="modal-warn">{error}</p>}

        <div className="modal-actions">
          {ch.break_id != null && (
            <button className="btn" onClick={unsplit} disabled={busy} title="Supprimer la coupure qui commence ce chapitre">
              Recoller au précédent
            </button>
          )}
          {ch.override_id != null && (
            <button className="btn" onClick={reset} disabled={busy} title="Revenir au découpage automatique">
              Réinitialiser
            </button>
          )}
          <span className="spacer" />
          <button className="btn" onClick={onClose} disabled={busy}>
            Annuler
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !dirty}>
            {busy ? <Spinner sm /> : "Enregistrer"}
          </button>
        </div>
      </div>
    </div>
  );
}
