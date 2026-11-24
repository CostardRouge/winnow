"use client";

// "Correct capture time…" — the one dialog every entry point opens (the
// viewer's ⋯ and its Date row, the per-media context menu, the bulk bar of the
// Gallery and of a session). docs/CAPTURE-TIME.md §6, migration 0061.
//
// A camera clock that was wrong (a zone left at home, a clock set by hand, a
// summer-time change missed) is corrected as a SHIFT stored beside what the
// file says; nothing is written into the originals. The dialog:
//   1. asks whose clock was wrong — the selection broken down by body, all
//      ticked; the body left unticked stays put (the phone was right);
//   2. takes the right time one of three ways — shift by ±h/min, set one
//      frame's local time (the others keep their gaps), or back to the files;
//   3. previews it from the server (days before → after, a few frames, what
//      follows), then applies one undoable correction.
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
  type MovedRow,
  formatDay,
  formatShift,
  formatWall,
} from "@/lib/captureCorrectionTypes";

export type CaptureTimeApplied = {
  message: string;
  /** The moved rows to patch in place, or null when there were too many to
   * send back — the host then reloads its list. */
  moved: MovedRow[] | null;
};

const PRESETS: Array<{ label: string; minutes: number }> = [
  { label: "−1 h", minutes: -60 },
  { label: "+1 h", minutes: 60 },
  { label: "−1 day", minutes: -1440 },
  { label: "+1 day", minutes: 1440 },
];

const bodyKey = (device: string | null) => device ?? "";

export default function CaptureTimeModal({
  ids,
  initialMode = "shift",
  onClose,
  onApplied,
}: {
  /** The selection; ids[0] is the frame "Set the time" talks about. */
  ids: number[];
  initialMode?: CorrectionMode;
  onClose: () => void;
  onApplied: (result: CaptureTimeApplied) => void;
}) {
  const [mode, setMode] = useState<CorrectionMode>(initialMode);
  const [later, setLater] = useState(true);
  const [hours, setHours] = useState(0);
  const [minutes, setMinutes] = useState(0);
  const [local, setLocal] = useState<string | null>(null);
  // null until the first answer names the bodies; then the ticked ones.
  const [ticked, setTicked] = useState<Set<string> | null>(null);
  const [bodies, setBodies] = useState<CorrectionPlan["bodies"] | null>(null);
  const [plan, setPlan] = useState<CorrectionPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const gen = useRef(0);
  const dialog = useRef<HTMLDivElement>(null);

  // Keys typed here are the dialog's: focused on open, and stopped at its
  // edge, so a viewer underneath never reads "x" as Reject or ← as Previous.
  useEffect(() => {
    dialog.current?.focus();
  }, []);

  const shiftS = (later ? 1 : -1) * (hours * 3600 + minutes * 60);

  const request = useMemo(() => {
    const base: Record<string, unknown> = {
      ids,
      devices: ticked ? [...ticked] : null,
      mode,
    };
    if (mode === "shift") base.shift_s = shiftS;
    if (mode === "set" && local) base.set = { id: ids[0], local };
    return base;
  }, [ids, ticked, mode, shiftS, local]);

  // "Set the time" starts from the reference frame's current local time.
  useEffect(() => {
    if (mode === "set" && !local && plan?.reference) setLocal(plan.reference.local);
  }, [mode, local, plan]);

  // The preview, debounced; an answer for a request no longer shown is dropped.
  useEffect(() => {
    if (mode === "set" && !local && plan?.reference) return;
    const my = ++gen.current;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const r = await fetchJson<{ plan: CorrectionPlan }>("/api/assets/capture-time", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Until "Set the time" has a time, preview it as a zero shift: the
          // bodies, the days and the reference frame are what the form needs.
          body: JSON.stringify(
            mode === "set" && !local ? { ...request, mode: "shift", shift_s: 0 } : request,
          ),
        });
        if (my !== gen.current) return;
        setError(null);
        setPlan(r.plan);
        if (!bodies) {
          setBodies(r.plan.bodies);
          setTicked(new Set(r.plan.bodies.map((b) => bodyKey(b.device))));
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
      const r = await fetchJson<{ plan: CorrectionPlan; moved: MovedRow[] | null }>(
        "/api/assets/capture-time",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...request, apply: true }),
        },
      );
      const n = r.plan.moving.toLocaleString("en-GB");
      const what =
        r.plan.mode === "revert"
          ? `Put ${n} media back to what their files say.`
          : `Moved ${n} media by ${formatShift(r.plan.deltaS)}.`;
      onApplied({
        message: `${what} Undo from Settings › Pipeline › Dates & places.`,
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
          {ids.length.toLocaleString("en-GB")} selected
          {added > 0 && <> · {added.toLocaleString("en-GB")} more from their piles and pairs</>}
          . Nothing is written into the files.
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
                    <span className="ctime-count">{b.count.toLocaleString("en-GB")}</span>
                  </label>
                );
              })}
            </div>
            <p className="ctime-hint">Untick the body whose clock was right: it stays put.</p>
          </fieldset>
        )}

        <div className="ctime-section">
          <span className="ctime-label">How do you know the right time?</span>
          <OptionPicker<CorrectionMode>
            ariaLabel="Method"
            value={mode}
            onChange={setMode}
            options={[
              { key: "shift", label: "Shift by", hint: "Add or take away hours and minutes" },
              { key: "set", label: "Set the time", hint: "Type one frame's time; the others keep their gaps" },
              { key: "revert", label: "Back to the file", hint: "Undo every correction these media carry" },
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

          {mode === "revert" && (
            <p className="ctime-panel ctime-hint">
              Every correction these media carry is taken off: they go back to the time their files
              state.
            </p>
          )}
        </div>

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
                {plan.moving > 0 ? (
                  <>
                    <strong>{plan.moving.toLocaleString("en-GB")}</strong> media move
                    {plan.deltaS != null && <> by <strong>{formatShift(plan.deltaS)}</strong></>}
                    {plan.unchanged > 0 && <>; {plan.unchanged.toLocaleString("en-GB")} stay as they are</>}.
                  </>
                ) : mode === "shift" && shiftS === 0 ? (
                  <>Say how far off the clock was.</>
                ) : mode === "set" && plan.deltaS === 0 ? (
                  <>Type the time it was really taken.</>
                ) : (
                  <>Nothing would move.</>
                )}
                {loading && <Spinner sm />}
              </p>

              {changedDays.length > 0 && (
                <table className="ctime-table">
                  <caption className="ctime-label">Days, before → after</caption>
                  <tbody>
                    {changedDays.slice(0, 8).map((d) => (
                      <tr key={d.date}>
                        <th scope="row">{formatDay(d.date)}</th>
                        <td className="ctime-count">{d.before.toLocaleString("en-GB")}</td>
                        <td aria-hidden>→</td>
                        <td className="ctime-count ctime-after">{d.after.toLocaleString("en-GB")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {changedDays.length > 8 && (
                <p className="ctime-hint">and {changedDays.length - 8} more days</p>
              )}

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
                    <li>
                      {plan.alreadyCorrected.toLocaleString("en-GB")} already carry a correction:
                      this one is added to it.
                    </li>
                  )}
                  {plan.trackPlaced > 0 && (
                    <li>
                      {plan.trackPlaced.toLocaleString("en-GB")} were placed by a GPS track at their
                      old time and keep that position.
                    </li>
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
            {plan && plan.moving > 0
              ? `Apply to ${plan.moving.toLocaleString("en-GB")} media`
              : "Apply"}
          </button>
        </div>
      </div>
    </div>
  );
}
