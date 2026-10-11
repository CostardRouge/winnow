"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  geotagAssets,
  geotagPoints,
  searchPlaces,
  type GeotagAsset,
  type GeotagSource,
  type PlaceSuggestion,
} from "@/lib/assetActions";
import { distanceM, type UnplacedConfidence } from "@/lib/unplacedTypes";
import { useOverlayDismiss } from "@/app/useOverlayDismiss";
import MediaViewer from "@/app/MediaViewer";
import type { PickedLocation } from "@/app/LocationPicker";
import type { RecapPlace } from "@/app/GeotagRecapModal";

// The stops dialog (docs/UNPLACED.md §11): ONE card's frames, split into
// stops — each a place — and placed in one gesture. Two hosts, one dialog:
//
//   - `place`: a folder whose located frames moved (Montpellier, then Sète).
//     Each stop has ONE pin, seeded with its suggestion; the human can drag
//     it, click the map, search a place or take a place already used, move
//     frames from one stop to the next, start a new stop, or leave frames
//     unplaced. Each stop is written through POST /api/assets/geotag — the
//     same write and the same rule as the one-pin recap: accepted as offered
//     (within move_m of its suggestion) records 'inferred', anything else
//     'manual';
//   - `trace`: "Follow a track…". Each frame already has ITS OWN point (where
//     the track was at its minute), the stops are how those points cluster,
//     and the pins are measurements: nothing is dragged. The human chooses
//     which stops to place and which frames to leave out; the write is POST
//     /api/assets/geotag/points, 'track' or 'inferred' per frame.
//
// What the maintainer asked of it, and why it is shaped so (2026-10-11): the
// frames of a stop are seen HERE — a stop unfolds into a contact sheet, a
// double-click opens the shared viewer stacked over the dialog (1/2/… move
// the frame to that stop, 0 leaves it out) — because opening the grid meant
// leaving the page, and coming back lost the dialog, the choices and the
// scroll. The grid is still a link, but a secondary one, and it opens in a
// new tab so this dialog survives it. Nothing is written before Place.

const LocationNone = "none";

const StopsMap = dynamic(() => import("@/app/StopsMap"), { ssr: false });

/** One stop as the dialog starts it. */
export type DialogStop = {
  key: string;
  /** "Montpellier, France" — the suggestion's cell, or the track's. */
  name: string | null;
  pin: PickedLocation | null;
  /** The point the stop was offered (place mode): how far the pin moves from
   *  it decides 'inferred' or 'manual'. Null for a stop with none. */
  seed: { lat: number; lon: number } | null;
  /** One line on where the pin came from. */
  note: string | null;
  confidence?: UnplacedConfidence;
  /** A followed track's stop that is a drive, not a place. */
  moving?: boolean;
};

/** Per-frame points of a followed track (trace mode). */
export type FramePoint = {
  lat: number;
  lon: number;
  source: "track" | "inferred";
  import_id: number | null;
};

type Frame = GeotagAsset & { at: number | null };

const fmt = (n: number) => n.toLocaleString("en-GB");
const timeFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });

function windowLabel(frames: Frame[]): string {
  const ts = frames.map((f) => f.at).filter((t): t is number => t != null);
  if (!ts.length) return "no capture time";
  const a = new Date(Math.min(...ts));
  const b = new Date(Math.max(...ts));
  const day = a.toDateString() === b.toDateString() ? "" : `${dayFmt.format(a)} `;
  const from = `${day}${timeFmt.format(a)}`;
  const to = `${day ? `${dayFmt.format(b)} ` : ""}${timeFmt.format(b)}`;
  return from === to ? from : `${from}–${to}`;
}

// The place search for the active stop: the geocoder's autocomplete, the
// LocationPicker's own source, in a compact form.
function PlaceSearch({ onPick, disabled }: { onPick: (p: PlaceSuggestion) => void; disabled: boolean }) {
  const [q, setQ] = useState("");
  const [list, setList] = useState<PlaceSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const t = q.trim();
    if (t.length < 3) {
      setList([]);
      return;
    }
    let alive = true;
    const h = setTimeout(() => {
      searchPlaces(t)
        .then((r) => {
          if (!alive) return;
          setList(r);
          setOpen(true);
        })
        .catch(() => alive && setList([]));
    }, 350);
    return () => {
      alive = false;
      clearTimeout(h);
    };
  }, [q]);
  return (
    <div className="place-search">
      <input
        className="input"
        type="text"
        placeholder="Search a place for this stop…"
        aria-label="Search a place for the active stop"
        value={q}
        disabled={disabled}
        autoComplete="off"
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => list.length && setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && open) {
            e.stopPropagation();
            setOpen(false);
          }
          if (e.key === "Enter" && list[0]) {
            e.preventDefault();
            onPick(list[0]);
            setOpen(false);
            setQ(list[0].display_name);
          }
        }}
      />
      {open && list.length > 0 && (
        <ul className="place-suggestions" role="listbox">
          {list.map((s, i) => (
            <li key={`${s.lat},${s.lon},${i}`} role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={i === 0}
                className="place-suggestion"
                onClick={() => {
                  onPick(s);
                  setOpen(false);
                  setQ(s.display_name);
                }}
              >
                {s.display_name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function StopsDialog({
  mode,
  title,
  subtitle,
  assets,
  stops: initialStops,
  assign: initialAssign,
  points,
  line,
  places,
  moveM,
  gridHref,
  onClose,
  onApplied,
}: {
  mode: "place" | "trace";
  title: string;
  subtitle: string;
  /** Every frame the dialog may place (the card's unplaced media). */
  assets: GeotagAsset[];
  stops: DialogStop[];
  /** Which stop each frame starts in; frames missing here start unplaced. */
  assign: Map<number, string>;
  /** Trace mode: each frame's own point. */
  points?: Map<number, FramePoint>;
  line?: { lat: number; lon: number }[];
  /** Positions already used near these dates (place mode). */
  places?: RecapPlace[];
  moveM: number;
  /** The grid on a window of the card, for the secondary link. */
  gridHref: (from: number, to: number) => string;
  onClose: () => void;
  onApplied: (message: string) => void;
}) {
  const frames = useMemo<Frame[]>(
    () =>
      assets
        .filter((a) => !a.gps)
        .map((a) => ({ ...a, at: a.captured_at ? Date.parse(a.captured_at) : null }))
        .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity) || a.id - b.id),
    [assets],
  );
  const [stops, setStops] = useState<DialogStop[]>(initialStops);
  const [assign, setAssign] = useState<Map<number, string>>(() => new Map(initialAssign));
  const [included, setIncluded] = useState<Set<string>>(() => new Set(initialStops.map((s) => s.key)));
  const [active, setActive] = useState<string | null>(initialStops[0]?.key ?? null);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [sel, setSel] = useState<{ stop: string; ids: Set<number>; anchor: number | null }>({
    stop: "",
    ids: new Set(),
    anchor: null,
  });
  const [viewing, setViewing] = useState<{ stop: string; index: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Stops already written by an apply that failed part-way: they leave the
  // plan, and closing the dialog reloads the list rather than pretending
  // nothing happened.
  const [written, setWritten] = useState<Set<string>>(() => new Set());
  const newCount = useRef(0);
  const close = useCallback(() => {
    if (written.size) onApplied(`${written.size} ${written.size === 1 ? "stop was" : "stops were"} placed before the error.`);
    else onClose();
  }, [written, onApplied, onClose]);

  const backdrop = useOverlayDismiss<HTMLDivElement>(() => {
    if (!busy) close();
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy && viewing == null) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, close, viewing]);

  const framesOf = useCallback(
    (key: string) => frames.filter((f) => (assign.get(f.id) ?? LocationNone) === key),
    [frames, assign],
  );
  const numberOf = (key: string) => stops.findIndex((s) => s.key === key) + 1;

  // --- Gestures on frames ---------------------------------------------------
  const moveTo = (ids: Iterable<number>, key: string) => {
    setAssign((prev) => {
      const next = new Map(prev);
      for (const id of ids) next.set(id, key);
      return next;
    });
    setSel({ stop: "", ids: new Set(), anchor: null });
  };
  const putBack = (ids: Iterable<number>) => {
    setAssign((prev) => {
      const next = new Map(prev);
      for (const id of ids) {
        const home = initialAssign.get(id);
        if (home) next.set(id, home);
      }
      return next;
    });
    setSel({ stop: "", ids: new Set(), anchor: null });
  };
  const newStop = (ids: Iterable<number>) => {
    newCount.current += 1;
    const key = `new-${newCount.current}`;
    setStops((prev) => [
      ...prev,
      { key, name: null, pin: null, seed: null, note: "A stop of your own — pick its place: search, a chip, or click the map." },
    ]);
    setIncluded((prev) => new Set(prev).add(key));
    setOpen((prev) => new Set(prev).add(key));
    setActive(key);
    moveTo(ids, key);
  };
  const setPin = (key: string, loc: PickedLocation) =>
    setStops((prev) => prev.map((s) => (s.key === key ? { ...s, pin: loc } : s)));

  const clickFrame = (stop: string, list: Frame[], i: number, shift: boolean) => {
    const id = list[i].id;
    setSel((prev) => {
      const ids = new Set(prev.stop === stop ? prev.ids : []);
      if (shift && prev.stop === stop && prev.anchor != null) {
        const a = list.findIndex((f) => f.id === prev.anchor);
        const [lo, hi] = a < i ? [a, i] : [i, a];
        for (let k = lo; k <= hi; k++) ids.add(list[k].id);
        return { stop, ids, anchor: prev.anchor };
      }
      if (ids.has(id)) ids.delete(id);
      else ids.add(id);
      return { stop, ids, anchor: id };
    });
  };

  // --- What Place will write --------------------------------------------------
  // What a stop will record: as offered — its own suggestion, or a spot
  // already used that was itself an accepted suggestion — 'inferred';
  // anything else (moved, searched, a hand-placed spot) 'manual'. Borrowing
  // a guess must never make it a fact.
  const unverified = useMemo(
    () => (places ?? []).filter((p) => p.verified === false).map((p) => ({ lat: p.lat, lon: p.lon })),
    [places],
  );
  const sourceOf = (s: DialogStop): GeotagSource => {
    if (!s.pin) return "manual";
    const offered = [...(s.seed ? [s.seed] : []), ...unverified];
    return offered.some((o) => distanceM(o, s.pin!) <= moveM) ? "inferred" : "manual";
  };
  const plan = stops
    .filter((s) => included.has(s.key) && !written.has(s.key))
    .map((s) => ({ stop: s, ids: framesOf(s.key).map((f) => f.id) }))
    .filter((p) => p.ids.length > 0);
  const missingPin = mode === "place" ? plan.filter((p) => !p.stop.pin) : [];
  const total = plan.reduce((n, p) => n + p.ids.length, 0);
  const leftOut = frames.length - total;

  async function apply() {
    if (!total || missingPin.length) return;
    setBusy(true);
    setError(null);
    try {
      let count = 0;
      if (mode === "trace") {
        const pts = plan.flatMap((p) =>
          p.ids.flatMap((id) => {
            const pt = points?.get(id);
            return pt ? [{ id, ...pt }] : [];
          }),
        );
        count = await geotagPoints(pts);
        const tracked = pts.filter((p) => p.source === "track").length;
        onApplied(
          `${fmt(count)} placed from the track in ${plan.length} ${plan.length === 1 ? "stop" : "stops"}` +
            (tracked ? ` (${fmt(tracked)} from an imported track)` : "") +
            ". Kept in Winnow, not written into the originals.",
        );
        return;
      }
      let verified = 0;
      for (const [k, p] of plan.entries()) {
        const src = sourceOf(p.stop);
        try {
          count += await geotagAssets(p.ids, { lat: p.stop.pin!.lat, lon: p.stop.pin!.lon }, src);
        } catch (e) {
          // Stops are written one by one: say which ones landed — they leave
          // the plan — and let the human retry the rest.
          const done = plan.slice(0, k).map((q) => numberOf(q.stop.key));
          throw new Error(
            `${(e as Error).message} — stop ${numberOf(p.stop.key)} was not placed` +
              (done.length ? `; ${done.length === 1 ? "stop" : "stops"} ${done.join(", ")} ${done.length === 1 ? "was" : "were"}.` : "."),
          );
        }
        setWritten((prev) => new Set(prev).add(p.stop.key));
        if (src === "manual") verified += p.ids.length;
      }
      onApplied(
        `${fmt(count)} placed in ${plan.length} ${plan.length === 1 ? "stop" : "stops"}.` +
          (verified ? ` ${fmt(verified)} as verified positions, written into the originals.` : " Recorded as suggested positions, not written into the originals."),
      );
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  // --- The map ----------------------------------------------------------------
  // Memoised: the map redraws its pins when THIS changes, not on every
  // click in the contact sheet.
  const mapStops = useMemo(
    () =>
      stops
        .map((s, i) => ({ s, number: i + 1 }))
        .filter(({ s }) => s.pin)
        .map(({ s, number }) => ({
          key: s.key,
          number,
          lat: s.pin!.lat,
          lon: s.pin!.lon,
          active: mode === "place" && s.key === active,
          draggable: mode === "place",
        })),
    [stops, mode, active],
  );
  const dots = useMemo(() => {
    if (mode !== "trace" || !points) return undefined;
    return frames
      .filter((f) => (assign.get(f.id) ?? LocationNone) !== LocationNone && included.has(assign.get(f.id)!))
      .flatMap((f) => {
        const p = points.get(f.id);
        return p ? [{ lat: p.lat, lon: p.lon }] : [];
      });
  }, [mode, points, frames, assign, included]);

  // --- The viewer stacked over the dialog --------------------------------------
  const viewList = viewing ? framesOf(viewing.stop) : [];
  const viewIndex = viewing ? Math.min(viewing.index, viewList.length - 1) : -1;
  useEffect(() => {
    if (viewing && viewList.length === 0) setViewing(null);
  }, [viewing, viewList.length]);

  const viewerMove = (f: Frame, key: string, rest: boolean) => {
    const list = framesOf(viewing!.stop);
    const i = list.findIndex((x) => x.id === f.id);
    const ids = rest ? list.slice(i).map((x) => x.id) : [f.id];
    if (key === "back") putBack(ids);
    else moveTo(ids, key);
  };

  // "2 · Sète" for a button: the stop's number, and its place's first part
  // when it has a name — a bare number otherwise, never the number twice.
  const shortName = (s: DialogStop, n: number) => {
    const name = (s.pin?.label ?? s.name)?.split(",")[0];
    return name ? `${n} · ${name}` : s.pin ? String(n) : `${n} · new stop`;
  };

  const stopName = (s: DialogStop) =>
    s.pin?.label ?? s.name ?? (s.pin ? `${s.pin.lat.toFixed(4)}, ${s.pin.lon.toFixed(4)}` : "No place yet");

  // --- One section: a stop, or the frames left out -------------------------------
  function section(key: string, s: DialogStop | null) {
    const list = framesOf(key);
    const n = s ? numberOf(key) : 0;
    const isOpen = open.has(key);
    const isOn = s ? included.has(key) : false;
    const selHere = sel.stop === key ? sel.ids : new Set<number>();
    if (!s && list.length === 0) return null;
    const ts = list.map((f) => f.at).filter((t): t is number => t != null);
    const toggleOpen = () =>
      setOpen((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    return (
      <section
        key={key}
        className={`stop-card${s && s.key === active && mode === "place" ? " is-active" : ""}${s && !isOn ? " is-off" : ""}${!s ? " is-out" : ""}`}
        aria-label={s ? `Stop ${n}` : "Left unplaced"}
      >
        <div className="stop-head">
          {s ? (
            <input
              type="checkbox"
              checked={isOn}
              disabled={busy}
              aria-label={`Place stop ${n}`}
              onChange={() =>
                setIncluded((prev) => {
                  const next = new Set(prev);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                })
              }
            />
          ) : (
            <span className="stop-out-mark" aria-hidden="true">–</span>
          )}
          {s ? (
            <button
              type="button"
              className={`stop-num${s.moving ? " is-moving" : ""}`}
              onClick={() => mode === "place" && setActive(key)}
              aria-label={mode === "place" ? `Make stop ${n} the one the map and search set` : `Stop ${n}`}
              disabled={mode !== "place"}
            >
              {n}
            </button>
          ) : null}
          <span className="stop-title">
            <strong>{s ? (s.moving ? `On the move${s.name ? ` · ${s.name}` : ""}` : stopName(s)) : "Left unplaced"}</strong>
            <span className="hint">
              {list.length ? windowLabel(list) : "no frame"} · {fmt(list.length)} {list.length === 1 ? "frame" : "frames"}
            </span>
          </span>
          {s && mode === "place" && s.pin && (
            <span className={`conf${sourceOf(s) === "manual" ? " is-high" : ""}`} title={sourceOf(s) === "manual" ? "Written into the originals" : "Kept in Winnow only"}>
              {sourceOf(s) === "manual" ? "verified" : "suggested"}
            </span>
          )}
          {s && mode === "place" && s.key !== active && (
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setActive(key)}>
              Change place…
            </button>
          )}
          {list.length > 0 && (
            <button type="button" className="btn btn-sm" aria-expanded={isOpen} onClick={toggleOpen}>
              {isOpen ? "Hide frames" : `Show ${fmt(list.length)}`}
            </button>
          )}
        </div>
        {s?.note && <p className="stop-note">{s.note}</p>}
        {s && mode === "place" && s.key === active && (
          <div className="stop-place">
            <PlaceSearch
              disabled={busy}
              onPick={(p) => setPin(key, { lat: p.lat, lon: p.lon, label: p.display_name })}
            />
            {places && places.length > 0 && (
              <div className="chips" role="group" aria-label="Places already used">
                {places.map((p) => (
                  <button
                    key={`${p.lat},${p.lon}`}
                    type="button"
                    className="chip"
                    title={p.title}
                    disabled={busy}
                    onClick={() => setPin(key, { lat: p.lat, lon: p.lon, label: p.label })}
                  >
                    {p.label}
                    <span className="chip-count">{p.detail}</span>
                  </button>
                ))}
              </div>
            )}
            <p className="hint">Or click the map, or drag pin {n}.</p>
          </div>
        )}
        {isOpen && list.length > 0 && (
          <>
            <div className="stop-sheet" role="listbox" aria-multiselectable="true" aria-label={s ? `Frames of stop ${n}` : "Frames left unplaced"}>
              {list.map((f, i) => {
                const on = selHere.has(f.id);
                return (
                  <button
                    key={f.id}
                    type="button"
                    role="option"
                    aria-selected={on}
                    className={`stop-thumb${on ? " is-selected" : ""}`}
                    title={`${f.filename}${f.at ? ` · ${timeFmt.format(new Date(f.at))}` : ""}`}
                    onClick={(e) => clickFrame(key, list, i, e.shiftKey)}
                    onDoubleClick={() => setViewing({ stop: key, index: i })}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/api/assets/${f.id}/thumb`} alt="" loading="lazy" />
                  </button>
                );
              })}
            </div>
            {selHere.size > 0 ? (
              <div className="stop-selbar" role="toolbar" aria-label="Selected frames">
                <strong>{fmt(selHere.size)} selected</strong>
                <span className="spacer" />
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setViewing({ stop: key, index: list.findIndex((f) => selHere.has(f.id)) })}
                >
                  View
                </button>
                {mode === "place" &&
                  stops
                    .filter((o) => o.key !== key)
                    .map((o) => (
                      <button key={o.key} type="button" className="btn btn-sm" onClick={() => moveTo(selHere, o.key)}>
                        Move to {shortName(o, numberOf(o.key))}
                      </button>
                    ))}
                {mode === "place" && (
                  <button type="button" className="btn btn-sm" onClick={() => newStop(selHere)}>
                    New stop…
                  </button>
                )}
                {s ? (
                  <button type="button" className="btn btn-sm" onClick={() => moveTo(selHere, LocationNone)}>
                    Leave unplaced
                  </button>
                ) : mode === "trace" ? (
                  <button type="button" className="btn btn-sm" onClick={() => putBack(selHere)}>
                    Put back
                  </button>
                ) : null}
              </div>
            ) : (
              <p className="hint stop-help">
                Click to select, Shift-click for a run, double-click to look closer.{" "}
                {ts.length > 0 && (
                  <a href={gridHref(Math.min(...ts), Math.max(...ts))} target="_blank" rel="noopener">
                    Open these in the grid ↗
                  </a>
                )}
              </p>
            )}
          </>
        )}
      </section>
    );
  }

  const viewed = viewIndex >= 0 ? viewList[viewIndex] : null;
  const viewedHome = viewed ? initialAssign.get(viewed.id) : undefined;

  return (
    <>
      <div className="modal-overlay" role="presentation" {...backdrop}>
        <div className="modal recap-modal stops-modal" role="dialog" aria-modal="true" aria-label={title}>
          <div className="stops-head">
            <h2 className="modal-title">{title}</h2>
            <p className="hint">{subtitle}</p>
          </div>
          <div className="stops-body">
            <div className="stops-map-col">
              <StopsMap
                stops={mapStops}
                line={line}
                dots={dots}
                onPick={mode === "place" && active ? (lat, lon) => setPin(active, { lat, lon, label: null }) : undefined}
                onMove={mode === "place" ? (key, lat, lon) => setPin(key, { lat, lon, label: null }) : undefined}
              />
            </div>
            <div className="stops-list">
              {stops.map((s) => section(s.key, s))}
              {section(LocationNone, null)}
            </div>
          </div>
          <div className="recap-foot">
            {error && <p className="modal-warn">{error}</p>}
            <div className="modal-actions">
              <span className="hint recap-foot-note">
                {missingPin.length
                  ? `Stop ${missingPin.map((p) => numberOf(p.stop.key)).join(", ")} has no place yet.`
                  : mode === "trace"
                    ? "Each frame at its own point. Kept in Winnow, never written into the originals."
                    : "Each stop at its own pin. As offered: suggested, Winnow only. Moved or picked: verified, written into the originals."}
                {leftOut > 0 ? ` ${fmt(leftOut)} left unplaced.` : ""}
              </span>
              <button className="btn" onClick={close} disabled={busy}>
                {written.size ? "Close" : "Cancel"}
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void apply()}
                disabled={busy || total === 0 || missingPin.length > 0}
              >
                {busy ? "Placing…" : `Place ${fmt(total)} · ${plan.length} ${plan.length === 1 ? "stop" : "stops"}`}
              </button>
            </div>
          </div>
        </div>
      </div>

      {viewed && viewing && (
        <MediaViewer
          items={viewList}
          index={viewIndex}
          onIndexChange={(i) => setViewing({ stop: viewing.stop, index: i })}
          onClose={() => setViewing(null)}
          renderInfo={(f) => {
            // Where this frame sits among the stops: each stop's first and
            // last frame, this one's time — the cut, readable at a glance.
            const t = f.at;
            return (
              <div className="stop-viewer-info">
                <p className="hint">
                  {viewing.stop === LocationNone
                    ? "Left unplaced"
                    : `Stop ${numberOf(viewing.stop)} · frame ${viewIndex + 1} of ${viewList.length}`}
                  {t != null ? ` · shot ${timeFmt.format(new Date(t))}` : ""}
                </p>
                <ol>
                  {stops.map((s, i) => {
                    const fs = framesOf(s.key);
                    return (
                      <li key={s.key} className={viewing.stop === s.key ? "is-here" : undefined}>
                        {shortName(s, i + 1)} — {fs.length ? windowLabel(fs) : "no frame"}
                      </li>
                    );
                  })}
                </ol>
              </div>
            );
          }}
          onKeyDown={(e, f) => {
            // 1…9 send the frame to that stop, 0 leaves it out; with Shift,
            // this frame and the rest of its stop — the cut moved in one key.
            const code = e.code.startsWith("Digit") ? Number(e.code.slice(5)) : NaN;
            if (Number.isNaN(code)) return;
            e.preventDefault();
            if (code === 0) return viewerMove(f, LocationNone, e.shiftKey);
            if (mode === "place" && code <= stops.length) viewerMove(f, stops[code - 1].key, e.shiftKey);
            if (mode === "trace" && viewing.stop === LocationNone) viewerMove(f, "back", e.shiftKey);
          }}
          renderActions={(f) => (
            <span className="stop-viewer-actions" role="group" aria-label="This frame goes to">
              {mode === "place" &&
                stops.map((s, i) => (
                  <button
                    key={s.key}
                    type="button"
                    className="btn btn-sm"
                    aria-pressed={viewing.stop === s.key}
                    onClick={() => viewerMove(f, s.key, false)}
                    title={`Move to stop ${i + 1} (key ${i + 1}, Shift for the rest of the stop)`}
                  >
                    {shortName(s, i + 1)}
                  </button>
                ))}
              {viewing.stop === LocationNone && mode === "trace" && viewedHome ? (
                <button type="button" className="btn btn-sm" onClick={() => viewerMove(f, "back", false)}>
                  Put back
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-sm"
                  aria-pressed={viewing.stop === LocationNone}
                  onClick={() => viewerMove(f, LocationNone, false)}
                  title="Leave this frame unplaced (key 0)"
                >
                  0 · Leave unplaced
                </button>
              )}
            </span>
          )}
        />
      )}
    </>
  );
}
