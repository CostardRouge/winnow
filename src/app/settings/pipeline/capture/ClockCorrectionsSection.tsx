"use client";

// Step 4 of Settings › Pipeline › Dates & places — every camera-clock
// correction made from the grids and the viewer ("Correct capture time…",
// CaptureTimeModal; migration 0061, docs/CAPTURE-TIME.md), newest first, each
// with its Undo.
//
// A correction is a shift stored beside what the files say, so Undo is a
// database write: it puts back the shift each row had, on the rows this
// correction still owns. A row a later correction moved again is left as it
// is, and the answer says how many.
import { useCallback, useEffect, useState } from "react";
import { Spinner } from "../../../ui";
import { fetchJson } from "@/lib/fetchJson";
import {
  type CorrectionRecord,
  type UndoReport,
  formatDay,
  formatShift,
  instantMs,
} from "@/lib/captureCorrectionTypes";

const n = (v: number) => v.toLocaleString("en-GB");

function when(text: string): string {
  const ms = instantMs(text);
  return ms == null
    ? text
    : new Date(ms).toLocaleString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

function how(c: CorrectionRecord): string {
  if (c.mode === "revert") return "back to the files";
  const shift = formatShift(c.shift_s);
  return c.mode === "set" ? `${shift} · one frame's time set` : shift;
}

// "Mon 11 Nov → Tue 12 Nov" for the days that emptied and filled, from the
// report the human confirmed.
function daysMoved(c: CorrectionRecord): string | null {
  const days = c.report?.days ?? [];
  const from = days.filter((d) => d.after < d.before).map((d) => d.date);
  const to = days.filter((d) => d.after > d.before).map((d) => d.date);
  if (!from.length && !to.length) return null;
  const fmt = (xs: string[]) =>
    xs.length === 0 ? "—" : xs.length === 1 ? formatDay(xs[0]) : `${xs.length} days`;
  return `${fmt(from)} → ${fmt(to)}`;
}

export default function ClockCorrectionsSection({ onChanged }: { onChanged: () => void }) {
  const [list, setList] = useState<CorrectionRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetchJson<{ corrections: CorrectionRecord[] }>(
        "/api/assets/capture-time/corrections",
      );
      setList(r.corrections);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function undo(c: CorrectionRecord) {
    setBusy(c.id);
    setMsg(null);
    try {
      const r = await fetchJson<{ undone: UndoReport }>(
        `/api/assets/capture-time/corrections/${c.id}`,
        { method: "DELETE" },
      );
      setMsg(
        `Undone: ${n(r.undone.restored)} media back where they were` +
          (r.undone.skipped > 0
            ? `; ${n(r.undone.skipped)} moved again since, left as they are.`
            : "."),
      );
      await load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  }

  const standing = list?.filter((c) => !c.undone_at).length ?? 0;

  return (
    <section className="flow-step" data-state={list && standing ? "todo" : "done"} aria-labelledby="clock-title">
      <header className="flow-step-head">
        <span className="flow-num" aria-hidden>
          4
        </span>
        <h2 id="clock-title">Clock corrections</h2>
        <span className="flow-state">{list ? `${n(standing)} standing` : ""}</span>
      </header>
      <p className="hint">
        A camera whose clock was wrong — a zone left at home, a summer-time change missed — is
        corrected from the grids or the viewer with <em>Correct capture time…</em> (key T). The
        correction is a shift kept beside the time each file states; nothing is written into the
        originals, so Capture One and Immich still read the files’ own dates.
      </p>

      {error && <p className="hint">{error}</p>}
      {msg && <p className="hint card-rules">{msg}</p>}
      {!list && !error && <Spinner />}
      {list && list.length === 0 && <p>No correction yet.</p>}

      {list && list.length > 0 && (
        <div className="vol-table-wrap">
          <table className="vol-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Shift</th>
                <th>Media</th>
                <th>Days</th>
                <th>Where</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {list.map((c) => {
                const sessions = c.report?.sessions ?? [];
                return (
                  <tr key={c.id}>
                    <td>
                      {when(c.created_at)}
                      {c.username && <div className="hint">{c.username}{c.via === "agent" ? " · agent" : ""}</div>}
                    </td>
                    <td>{how(c)}</td>
                    <td>{n(c.asset_count)}</td>
                    <td>{daysMoved(c) ?? "same days"}</td>
                    <td title={sessions.map((s) => s.name).join("\n")}>
                      {sessions.length === 0
                        ? "—"
                        : sessions.length === 1
                          ? sessions[0].name
                          : `${sessions[0].name} and ${n(sessions.length - 1)} more`}
                    </td>
                    <td>
                      {c.undone_at ? (
                        <span className="hint">
                          Undone {when(c.undone_at)}
                          {c.undo_report && c.undo_report.skipped > 0
                            ? ` · ${n(c.undo_report.skipped)} left`
                            : ""}
                        </span>
                      ) : confirming === c.id ? (
                        <span className="flow-actions">
                          <button
                            type="button"
                            className="btn btn-sm btn-primary"
                            disabled={busy != null}
                            onClick={() => void undo(c)}
                          >
                            {busy === c.id ? "Undoing…" : `Undo ${n(c.asset_count)}`}
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={busy != null}
                            onClick={() => setConfirming(null)}
                          >
                            Keep
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={busy != null}
                          onClick={() => setConfirming(c.id)}
                        >
                          Undo…
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
