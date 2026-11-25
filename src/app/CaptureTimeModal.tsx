"use client";

// "Correct capture time…" — the one dialog every entry point opens (the
// viewer's ⋯ and its Date row, the per-media context menu, the bulk bar of the
// Gallery and of a session, a session's ⋯, a "clock looks wrong" suggestion).
// docs/CAPTURE-TIME.md §6, migrations 0061–0062.
//
// A camera clock that was wrong (a zone left at home, a clock set by hand, a
// summer-time change missed) is corrected as a SHIFT stored beside what the
// file says; nothing is written into the originals. The dialog:
//   1. asks whose clock was wrong — the selection broken down by body, all
//      ticked unless a suggestion says which; the body left unticked stays
//      put (the phone was right);
//   2. takes the right time one of four ways — shift by ±h/min, set one
//      frame's local time, match a frame against one another body shot at
//      the same moment, or name the two time zones — or goes back to the
//      files;
//   3. previews it from the server (days before → after, a few frames, what
//      follows: sessions, GPS-track positions, Immich), then applies one
//      undoable correction.
// The server widens the selection first: a burst pile cut by it is taken
// whole, a pair's other file follows (lib/captureCorrections.ts).
import { useEffect, useMemo, useRef, useState } from "react";
import { Spinner } from "./ui";
import { OptionPicker } from "./OptionPicker";
import { useOverlayDismiss } from "./useOverlayDismiss";
import { friendlyCameraName } from "@/lib/cameraLabels";
import { fetchJson } from "@/lib/fetchJson";
import {
  type CorrectionMode,
  type CorrectionPlan,
  type ImmichDateReport,
  type MovedRow,
  formatDay,
  formatShift,
  formatWall,
  formatWallShort,
} from "@/lib/captureCorrectionTypes";

export type CaptureTimeApplied = {
  message: string;
  /** The moved rows to patch in place, or null when there were too many to
   * send back — the host then reloads its list. */
  moved: MovedRow[] | null;
};

type Method = Exclude<CorrectionMode, "revert">;

const PRESETS: Array<{ label: string; minutes: number }> = [
  { label: "−1 h", minutes: -60 },
  { label: "+1 h", minutes: 60 },
  { label: "−1 day", minutes: -1440 },
  { label: "+1 day", minutes: 1440 },
];

const bodyKey = (device: string | null) => device ?? "";
const n = (v: number) => v.toLocaleString("en-GB");

// Every IANA zone the browser knows, for the Time zone method.
function allZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  try {
    return intl.supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
}
const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

export default function CaptureTimeModal({
  ids,
  initialMode = "shift",
  initialDevices,
  initialShiftS,
  initialPair,
  onClose,
  onApplied,
}: {
  /** The selection; ids[0] is the frame "Set the time" and "Match a frame"
   * talk about. */
  ids: number[];
  initialMode?: CorrectionMode;
  /** The bodies to tick (a suggestion names the one to move); all otherwise. */
  initialDevices?: string[];
  /** A shift to start from (a suggestion's). */
  initialShiftS?: number;
  /** A pair to start "Match a frame" from (a suggestion's example). */
  initialPair?: { wrongId: number; rightId: number };
  onClose: () => void;
  onApplied: (result: CaptureTimeApplied) => void;
}) {
  const [mode, setMode] = useState<CorrectionMode>(initialMode);
  const [lastMethod, setLastMethod] = useState<Method>(
    initialMode === "revert" ? "shift" : initialMode,
  );
  const startS = initialShiftS ?? 0;
  const [later, setLater] = useState(startS >= 0);
  const [hours, setHours] = useState(Math.floor(Math.abs(startS) / 3600));
  const [minutes, setMinutes] = useState(Math.floor((Math.abs(startS) % 3600) / 60));
  const [local, setLocal] = useState<string | null>(null);
  const [rightId, setRightId] = useState<number | null>(initialPair?.rightId ?? null);
  const [round, setRound] = useState(true);
  const [zoneFrom, setZoneFrom] = useState<string>("Europe/Paris");
  const [zoneTo, setZoneTo] = useState<string | null>(null);
  // null until the first answer names the bodies; then the ticked ones.
  const [ticked, setTicked] = useState<Set<string> | null>(
    initialDevices ? new Set(initialDevices) : null,
  );
  const [bodies, setBodies] = useState<CorrectionPlan["bodies"] | null>(null);
  const [plan, setPlan] = useState<CorrectionPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const gen = useRef(0);
  const dialog = useRef<HTMLDivElement>(null);
  const zones = useMemo(allZones, []);

  // Keys typed here are the dialog's: focused on open, and stopped at its
  // edge, so a viewer underneath never reads "x" as Reject or ← as Previous.
  useEffect(() => {
    dialog.current?.focus();
  }, []);

  const shiftS = (later ? 1 : -1) * (hours * 3600 + minutes * 60);
  const wrongId = initialPair?.wrongId ?? plan?.reference?.id ?? ids[0];

  const request = useMemo(() => {
    const base: Record<string, unknown> = {
      ids,
      devices: ticked ? [...ticked] : null,
      mode,
    };
    if (mode === "shift") base.shift_s = shiftS;
    // Until "Set the time" has a time and "Time zone" a place, preview them as
    // a zero shift: the bodies, the days and the reference frame are what the
    // form needs first.
    if (mode === "set") {
      if (local) base.set = { id: wrongId, local };
      else Object.assign(base, { mode: "shift", shift_s: 0 });
    }
    if (mode === "match" && rightId != null)
      base.pair = { wrong_id: wrongId, right_id: rightId, round };
    if (mode === "zone") {
      if (zoneTo) base.zone = { from: zoneFrom, to: zoneTo };
      else Object.assign(base, { mode: "shift", shift_s: 0 });
    }
    return base;
  }, [ids, ticked, mode, shiftS, local, wrongId, rightId, round, zoneFrom, zoneTo]);

  // "Set the time" starts from the reference frame's current local time;
  // "Time zone" from where the selection's own positions say it was.
  useEffect(() => {
    if (mode === "set" && !local && plan?.reference) setLocal(plan.reference.local);
    if (mode === "zone" && !zoneTo && plan) setZoneTo(plan.placeZone ?? browserZone());
  }, [mode, local, zoneTo, plan]);

  // The preview, debounced; an answer for a request no longer shown is dropped.
  useEffect(() => {
    const my = ++gen.current;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const r = await fetchJson<{ plan: CorrectionPlan }>("/api/assets/capture-time", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        });
        if (my !== gen.current) return;
        setError(null);
        setPlan(r.plan);
        if (!bodies) {
          setBodies(r.plan.bodies);
          if (!ticked) setTicked(new Set(r.plan.bodies.map((b) => bodyKey(b.device))));
        }
      } catch (e) {
        if (my !== gen.current) return;
        setError((e as Error).message);
      } finally {
        if (my === gen.current) setLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [busy, onClose]);

  const dismiss = useOverlayDismiss<HTMLDivElement>(() => !busy && onClose());

  async function apply() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetchJson<{
        plan: CorrectionPlan;
        moved: MovedRow[] | null;
        immich: ImmichDateReport | null;
      }>("/api/assets/capture-time", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...request, apply: true }),
      });
      const m = n(r.plan.moving);
      const what =
        r.plan.mode === "revert"
          ? `Put ${m} media back to what their files say.`
          : r.plan.mode === "zone"
            ? `Corrected the time zone of ${m} media.`
            : `Moved ${m} media by ${formatShift(r.plan.deltaS)}.`;
      const immich = r.immich
        ? r.immich.failed
          ? ` Immich refused ${n(r.immich.failed)} date(s): ${r.immich.error}.`
          : ` ${n(r.immich.updated)} date(s) updated in Immich.`
        : "";
      onApplied({
        message: `${what}${immich} Undo from Settings › Pipeline › Dates & places.`,
        moved: r.moved,
      });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const changedDays = (plan?.days ?? []).filter((d) => d.before !== d.after);
  const added = plan ? plan.expanded - plan.selected : 0;
  const canApply = !!plan && plan.moving > 0 && !loading && !busy && !error;
  const pick = (m: Method) => {
    setMode(m);
    setLastMethod(m);
  };

  let summary: React.ReactNode;
  if (!plan) summary = null;
  else if (plan.moving > 0)
    summary =
      plan.mode === "zone" ? (
        <>
          <strong>{n(plan.moving)}</strong> media change:{" "}
          {plan.zoneOnly > 0 && <>{n(plan.zoneOnly)} keep their moment and are filed in the new zone</>}
          {plan.zoneOnly > 0 && plan.shifted > 0 && "; "}
          {plan.shifted > 0 && <>{n(plan.shifted)} wall clocks move by the zones’ difference</>}.
        </>
      ) : (
        <>
          <strong>{n(plan.moving)}</strong> media move
          {plan.deltaS != null && (
            <>
              {" "}
              by <strong>{formatShift(plan.deltaS)}</strong>
            </>
          )}
          {plan.unchanged > 0 && <>; {n(plan.unchanged)} stay as they are</>}.
        </>
      );
  else if (mode === "shift" && shiftS === 0) summary = <>Say how far off the clock was.</>;
  else if (mode === "set") summary = <>Type the time it was really taken.</>;
  else if (mode === "match" && rightId == null) summary = <>Pick the frame of the same moment.</>;
  else summary = <>Nothing would move.</>;

  return (
    <div className="modal-backdrop" {...dismiss}>
      <div
        ref={dialog}
        className="modal ctime"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ctime-title"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key !== "Escape") e.stopPropagation();
        }}
      >
        <h3 id="ctime-title" className="modal-title">
          Correct the capture time
        </h3>
        <p className="ctime-lede">
          {n(ids.length)} selected
          {added > 0 && <> · {n(added)} more from their piles and pairs</>}. Nothing is written into
          the files.
        </p>

        {bodies && bodies.length > 1 && (
          <fieldset className="ctime-section">
            <legend className="ctime-label">Whose clock was wrong?</legend>
            <div className="ctime-bodies">
              {bodies.map((b) => {
                const k = bodyKey(b.device);
                const on = ticked?.has(k) ?? true;
                return (
                  <label key={k} className={`ctime-body${on ? " is-on" : ""}`}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() =>
                        setTicked((cur) => {
                          const next = new Set(cur ?? []);
                          if (next.has(k)) next.delete(k);
                          else next.add(k);
                          return next;
                        })
                      }
                    />
                    <span className="ctime-body-name">
                      {b.device ? friendlyCameraName(b.device) : "No camera body"}
                    </span>
                    <span className="ctime-count">{n(b.count)}</span>
                  </label>
                );
              })}
            </div>
            <p className="ctime-hint">Untick the body whose clock was right: it stays put.</p>
          </fieldset>
        )}

        {mode === "revert" ? (
          <div className="ctime-section">
            <span className="ctime-label">Back to the files</span>
            <p className="ctime-panel ctime-hint">
              Every correction these media carry is taken off — the shift and a zone set by hand:
              they go back to the time their files state.{" "}
              <button type="button" className="ctime-link" onClick={() => setMode(lastMethod)}>
                Choose a method instead
              </button>
            </p>
          </div>
        ) : (
          <div className="ctime-section">
            <div className="ctime-label-row">
              <span className="ctime-label">How do you know the right time?</span>
              <button type="button" className="ctime-link" onClick={() => setMode("revert")}>
                Back to the file…
              </button>
            </div>
            <OptionPicker<Method>
              ariaLabel="Method"
              value={mode}
              onChange={pick}
              options={[
                { key: "shift", label: "Shift by", hint: "Add or take away hours and minutes" },
                { key: "set", label: "Set the time", hint: "Type one frame's time; the others keep their gaps" },
                { key: "match", label: "Match a frame", hint: "Another camera shot the same moment" },
                { key: "zone", label: "Time zone", hint: "The camera stayed on another place's time" },
              ]}
            />

            {mode === "shift" && (
              <div className="ctime-panel">
                <div className="ctime-shift">
                  <select
                    className="input"
                    aria-label="Direction"
                    value={later ? "later" : "earlier"}
                    onChange={(e) => setLater(e.target.value === "later")}
                  >
                    <option value="later">Later by</option>
                    <option value="earlier">Earlier by</option>
                  </select>
                  <label className="ctime-num">
                    <input
                      className="input"
                      type="number"
                      min={0}
                      max={8784}
                      value={hours}
                      onChange={(e) => setHours(Math.max(0, Math.min(8784, Number(e.target.value) || 0)))}
                    />
                    h
                  </label>
                  <label className="ctime-num">
                    <input
                      className="input"
                      type="number"
                      min={0}
                      max={59}
                      value={minutes}
                      onChange={(e) => setMinutes(Math.max(0, Math.min(59, Number(e.target.value) || 0)))}
                    />
                    min
                  </label>
                </div>
                <div className="ctime-presets">
                  {PRESETS.map((p) => (
                    <button
                      key={p.label}
                      type="button"
                      className="chip"
                      onClick={() => {
                        const total = shiftS / 60 + p.minutes;
                        setLater(total >= 0);
                        setHours(Math.floor(Math.abs(total) / 60));
                        setMinutes(Math.abs(total) % 60);
                      }}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {mode === "set" && (
              <div className="ctime-panel">
                {plan?.reference ? (
                  <label className="ctime-set">
                    <span>
                      <strong>{plan.reference.filename}</strong> was taken at
                    </span>
                    <input
                      className="input"
                      type="datetime-local"
                      step={1}
                      value={local ?? ""}
                      onChange={(e) => setLocal(e.target.value || null)}
                    />
                    <span className="ctime-hint">
                      local time where it was shot · now {formatWall(plan.reference.local, true)}
                    </span>
                  </label>
                ) : (
                  <Spinner sm />
                )}
              </div>
            )}

            {mode === "match" && (
              <div className="ctime-panel">
                {plan?.reference ? (
                  <div className="ctime-match">
                    <figure className="ctime-frame">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={`/api/assets/${plan.reference.id}/thumb`} alt="" loading="lazy" />
                      <figcaption>
                        <strong>{plan.reference.filename}</strong>
                        <span className="ctime-hint">
                          {friendlyCameraName(plan.reference.device)} · says{" "}
                          {formatWall(plan.reference.local, true)}
                        </span>
                      </figcaption>
                    </figure>
                    <span className="ctime-eq" aria-hidden>
                      =
                    </span>
                    <div className="ctime-cands" role="radiogroup" aria-label="The same moment">
                      {plan.candidates.length === 0 && (
                        <p className="ctime-hint">
                          No other camera shot within a day of this frame.
                        </p>
                      )}
                      {plan.candidates.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          role="radio"
                          aria-checked={rightId === c.id}
                          className={`ctime-cand${rightId === c.id ? " is-on" : ""}`}
                          onClick={() => setRightId(c.id)}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={`/api/assets/${c.id}/thumb`} alt="" loading="lazy" />
                          <span className="ctime-cand-text">
                            <span className="ctime-cand-time">{formatWallShort(c.local)}</span>
                            <span className="ctime-hint">{friendlyCameraName(c.device)}</span>
                            {c.similarity != null && (
                              <span className="ctime-hint">{Math.round(c.similarity * 100)} % alike</span>
                            )}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <Spinner sm />
                )}
                <label className="ctime-check">
                  <input type="checkbox" checked={round} onChange={(e) => setRound(e.target.checked)} />
                  Round to the nearest 15 min (a zone mistake, not a drifting clock)
                </label>
                {plan?.pair?.measuredS != null && (
                  <p className="ctime-hint">
                    Measured between the two frames: {formatShift(plan.pair.measuredS)}.
                  </p>
                )}
              </div>
            )}

            {mode === "zone" && (
              <div className="ctime-panel">
                <div className="ctime-zones">
                  <label className="ctime-zone">
                    <span className="ctime-hint">The camera’s clock was on</span>
                    <select className="input" value={zoneFrom} onChange={(e) => setZoneFrom(e.target.value)}>
                      {(zones.includes(zoneFrom) ? zones : [zoneFrom, ...zones]).map((z) => (
                        <option key={z} value={z}>
                          {z}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="ctime-zone">
                    <span className="ctime-hint">You were in</span>
                    <select
                      className="input"
                      value={zoneTo ?? ""}
                      onChange={(e) => setZoneTo(e.target.value || null)}
                    >
                      {zoneTo && !zones.includes(zoneTo) && <option value={zoneTo}>{zoneTo}</option>}
                      {zones.map((z) => (
                        <option key={z} value={z}>
                          {z}
                          {z === plan?.placeZone ? " — from their positions" : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <p className="ctime-hint">
                  A file that wrote its zone kept the right moment: only the zone its day is filed in
                  changes. A file with no zone is moved by the difference between the two, at its own
                  date — summer time included.
                </p>
              </div>
            )}
          </div>
        )}

        <div className="ctime-preview" aria-live="polite">
          {error && (
            <p className="dev-pick-warn" role="alert">
              {error}
            </p>
          )}
          {!plan && loading && <Spinner sm />}
          {plan && (
            <>
              <p className="ctime-summary">
                {summary}
                {loading && <Spinner sm />}
              </p>

              {changedDays.length > 0 && (
                <table className="ctime-table">
                  <caption className="ctime-label">Days, before → after</caption>
                  <tbody>
                    {changedDays.slice(0, 8).map((d) => (
                      <tr key={d.date}>
                        <th scope="row">{formatDay(d.date)}</th>
                        <td className="ctime-count">{n(d.before)}</td>
                        <td aria-hidden>→</td>
                        <td className="ctime-count ctime-after">{n(d.after)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {changedDays.length > 8 && <p className="ctime-hint">and {changedDays.length - 8} more days</p>}

              {plan.moving > 0 && plan.samples.length > 0 && (
                <table className="ctime-table ctime-samples">
                  <caption className="ctime-label">Frames, now → after</caption>
                  <tbody>
                    {plan.samples.map((s) => (
                      <tr key={s.id}>
                        <th scope="row">{s.filename}</th>
                        <td>{formatWall(s.before)}</td>
                        <td aria-hidden>→</td>
                        <td className="ctime-after">{formatWall(s.after)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {plan.moving > 0 && (
                <ul className="ctime-follows">
                  {plan.sessions.length > 0 && (
                    <li>
                      {plan.sessions.length === 1
                        ? `The session “${plan.sessions[0].name}” is re-spanned.`
                        : `${plan.sessions.length} sessions are re-spanned.`}
                    </li>
                  )}
                  {plan.alreadyCorrected > 0 && plan.mode !== "revert" && (
                    <li>{n(plan.alreadyCorrected)} already carry a correction: this one is added to it.</li>
                  )}
                  {plan.trackPlaced > 0 && (
                    <li>
                      {n(plan.trackPlaced)} were placed by a GPS track at their old time and are matched
                      again at the new one
                      {plan.track.moved > 0 && <>: {n(plan.track.moved)} move</>}
                      {plan.track.cleared > 0 && (
                        <>
                          {plan.track.moved > 0 ? "," : ":"} {n(plan.track.cleared)} lose their position
                          (no fix then)
                        </>
                      )}
                      .
                    </li>
                  )}
                  {plan.inImmich > 0 && (
                    <li>{n(plan.inImmich)} are in Immich: their date there is updated too.</li>
                  )}
                  <li>Undo it from Settings › Pipeline › Dates &amp; places.</li>
                </ul>
              )}
            </>
          )}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={apply} disabled={!canApply}>
            {busy ? <Spinner sm /> : null}
            {plan && plan.moving > 0 ? `Apply to ${n(plan.moving)} media` : "Apply"}
          </button>
        </div>
      </div>
    </div>
  );
}
