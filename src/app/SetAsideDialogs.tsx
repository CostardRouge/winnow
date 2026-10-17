"use client";

import { useEffect, useMemo, useState } from "react";
import MediaViewer from "@/app/MediaViewer";
import { useOverlayDismiss } from "@/app/useOverlayDismiss";
import { exemptAssets, geotagPoints } from "@/lib/assetActions";
import { formatCaptureSpan } from "@/lib/format";
import type { AsideMedia, GradedExport } from "@/lib/unplacedTypes";

// The two dialogs of the Unplaced view's plan band (docs/UNPLACED.md §12) —
// the media its cards leave out because a time-based suggestion can only get
// them wrong.
//
//   - NotAPlaceDialog: screenshots and files saved from another app, as a
//     contact sheet. Every tile starts ticked; the human unticks what was
//     really shot somewhere (a drone clip that went through the phone), then
//     "Leave N unplaced" — the existing geo-exempt, which the page offers to
//     undo. A picture opens the shared viewer; the tick decides, as in the
//     recap's own sheet.
//   - GradedDialog: graded exports beside the clip each was exported from and
//     that clip's position. "Copy N positions" writes them per frame through
//     api/assets/geotag/points as 'inferred' — never into the files, never
//     over a position. The exports with no source (or several that disagree)
//     are listed by folder, each with a Place… that opens the ordinary recap
//     on an empty map: their own hours say nothing about where they were shot.

const fmt = (n: number) => n.toLocaleString("en-GB");
const dayFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });
const day = (iso: string | null) => (iso ? dayFmt.format(new Date(iso)) : "—");

// A contact sheet draws this many tiles per kind, then "Show N more" — the
// recap's own step (GeotagRecapModal's SHEET_STEP).
const SHEET_STEP = 300;

// Escape closes the dialog unless the viewer is open over it (the viewer
// takes Escape itself) or a write is in flight.
function useEscape(onClose: () => void, blocked: boolean) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !blocked) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, blocked]);
}

const KINDS: { kind: AsideMedia["kind"]; title: string; rule: string }[] = [
  {
    kind: "screenshot",
    title: "Screenshots",
    rule: "A PNG whose file names no camera — phones save their own photos as HEIC or JPEG.",
  },
  {
    kind: "saved",
    title: "Saved from another app",
    rule: "Named the way iOS names media it imports (RSJQ2434.MP4) and no camera in the file: its time is when it was saved, not shot.",
  },
];

export function NotAPlaceDialog({
  items,
  truncated,
  cap,
  onClose,
  onApplied,
}: {
  items: AsideMedia[];
  truncated: boolean;
  cap: number;
  onClose: () => void;
  /** How many were exempted, and their ids — the page offers the undo. */
  onApplied: (n: number, ids: number[]) => void;
}) {
  const [off, setOff] = useState<Set<number>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState<Record<string, number>>({});
  const [viewing, setViewing] = useState<{ list: AsideMedia[]; i: number } | null>(null);
  const backdrop = useOverlayDismiss<HTMLDivElement>(() => {
    if (!busy && !viewing) onClose();
  });
  useEscape(onClose, busy || viewing != null);

  const toggle = (id: number) =>
    setOff((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const setAll = (list: AsideMedia[], on: boolean) =>
    setOff((prev) => {
      const next = new Set(prev);
      for (const a of list) {
        if (on) next.delete(a.id);
        else next.add(a.id);
      }
      return next;
    });

  const kept = items.filter((a) => !off.has(a.id));

  async function apply() {
    if (!kept.length) return;
    setBusy(true);
    setError(null);
    try {
      const ids = kept.map((a) => a.id);
      const n = await exemptAssets(ids, true);
      onApplied(n, ids);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <>
      <div className="modal-overlay" role="presentation" {...backdrop}>
        <div className="modal modal-wide aside-modal" role="dialog" aria-modal="true" aria-labelledby="nap-title">
          <h2 id="nap-title" className="modal-title">
            Not a place · {fmt(items.length)}
          </h2>
          <p className="hint">
            Nothing here was shot anywhere. They stay in the library and leave this backlog;
            untick anything that really was taken somewhere.
          </p>
          {truncated && (
            <p className="modal-warn">Only the first {fmt(cap)} of each kind are listed — apply, then open this again for the rest.</p>
          )}

          <div className="aside-body">
            {KINDS.map(({ kind, title, rule }) => {
              const list = items.filter((a) => a.kind === kind);
              if (!list.length) return null;
              const shownN = more[kind] ?? SHEET_STEP;
              const shown = list.slice(0, shownN);
              const offHere = list.filter((a) => off.has(a.id)).length;
              return (
                <section key={kind} className="aside-group" aria-label={title}>
                  <div className="aside-group-head">
                    <h3>
                      {title} · {fmt(list.length)}
                    </h3>
                    <button
                      type="button"
                      className="link-btn"
                      disabled={busy}
                      onClick={() => setAll(list, offHere > 0)}
                    >
                      {offHere > 0 ? "Tick all" : "Untick all"}
                    </button>
                  </div>
                  <p className="hint">{rule}</p>
                  <div className="recap-sheet" role="group" aria-label={title}>
                    {shown.map((a, i) => {
                      const on = !off.has(a.id);
                      return (
                        <div key={a.id} className={`recap-sheet-item${on ? "" : " is-skipped"}`}>
                          <button
                            type="button"
                            className="recap-sheet-thumb"
                            onClick={() => setViewing({ list: shown, i })}
                            title={`${a.filename} — ${a.folder}`}
                            aria-label={`View ${a.filename}`}
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={`/api/assets/${a.id}/thumb`} alt="" loading="lazy" />
                          </button>
                          <input
                            type="checkbox"
                            checked={on}
                            disabled={busy}
                            onChange={() => toggle(a.id)}
                            aria-label={`Leave ${a.filename} unplaced`}
                          />
                        </div>
                      );
                    })}
                  </div>
                  {list.length > shown.length && (
                    <button
                      type="button"
                      className="btn btn-sm aside-more"
                      onClick={() => setMore((m) => ({ ...m, [kind]: shownN + SHEET_STEP }))}
                    >
                      Show {fmt(Math.min(SHEET_STEP, list.length - shown.length))} more
                    </button>
                  )}
                </section>
              );
            })}
          </div>

          {error && <p className="modal-warn">{error}</p>}
          <div className="modal-actions">
            <span className="hint recap-foot-note">
              {off.size > 0 ? `${fmt(off.size)} unticked stay in Unplaced · ` : ""}
              Undo right after, or from the grid’s Exempt filter.
            </span>
            <button className="btn" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={() => void apply()} disabled={busy || !kept.length}>
              {busy ? "Working…" : `Leave ${fmt(kept.length)} unplaced`}
            </button>
          </div>
        </div>
      </div>

      {viewing && (
        <MediaViewer
          items={viewing.list}
          index={viewing.i}
          onIndexChange={(i) => setViewing((v) => (v ? { ...v, i } : v))}
          onClose={() => setViewing(null)}
          renderActions={(a) => {
            // A pressed button, not a checkbox: the viewer leaves the keyboard
            // alone while an <input> has focus (the recap's own reason).
            const on = !off.has(a.id);
            return (
              <button
                type="button"
                className="btn recap-viewer-check"
                aria-pressed={on}
                disabled={busy}
                onClick={() => toggle(a.id)}
              >
                <span className="recap-viewer-box" aria-hidden="true">
                  {on ? "✓" : ""}
                </span>
                Leave unplaced
              </button>
            );
          }}
        />
      )}
    </>
  );
}

// The tail of a path a row has room for: "…/original/video/DJI_0054_D.MP4".
function pathTail(p: string, parts = 3): string {
  const seg = p.split("/");
  return seg.length > parts ? `…/${seg.slice(-parts).join("/")}` : p;
}

export function GradedDialog({
  items,
  truncated,
  cap,
  onClose,
  onApplied,
  onPlaceLoose,
}: {
  items: GradedExport[];
  truncated: boolean;
  cap: number;
  onClose: () => void;
  onApplied: (message: string) => void;
  /** Place the exports of one folder that found no source, by hand. */
  onPlaceLoose: (folder: { id: number; name: string }, rows: GradedExport[]) => void;
}) {
  const matched = useMemo(() => items.filter((x) => x.source), [items]);
  const loose = useMemo(() => items.filter((x) => !x.source), [items]);
  const [off, setOff] = useState<Set<number>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const backdrop = useOverlayDismiss<HTMLDivElement>(() => {
    if (!busy) onClose();
  });
  useEscape(onClose, busy);

  const looseFolders = useMemo(() => {
    const m = new Map<number, { id: number; name: string; rows: GradedExport[] }>();
    for (const x of loose) {
      const f = m.get(x.session_id) ?? { id: x.session_id, name: x.folder, rows: [] };
      f.rows.push(x);
      m.set(x.session_id, f);
    }
    return [...m.values()].sort((a, b) => b.rows.length - a.rows.length);
  }, [loose]);

  const chosen = matched.filter((x) => !off.has(x.id));
  const toggle = (id: number) =>
    setOff((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function apply() {
    if (!chosen.length) return;
    setBusy(true);
    setError(null);
    try {
      const n = await geotagPoints(
        chosen.map((x) => ({
          id: x.id,
          lat: x.source!.lat,
          lon: x.source!.lon,
          source: "inferred" as const,
          import_id: null,
        })),
      );
      const skipped = chosen.length - n;
      onApplied(
        `${fmt(n)} graded ${n === 1 ? "export" : "exports"} placed where ${n === 1 ? "its" : "their"} source was shot${skipped > 0 ? ` · ${fmt(skipped)} already had a position` : ""}`,
      );
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" role="presentation" {...backdrop}>
      <div className="modal modal-wide aside-modal" role="dialog" aria-modal="true" aria-labelledby="graded-title">
        <h2 id="graded-title" className="modal-title">
          Graded exports · {fmt(items.length)}
        </h2>
        <p className="hint">
          A file named <code>…_lut_YYYYMMDD</code> carries the date of its export, so its hours say
          where it was graded, not where it was shot. Its position comes from the clip it was
          exported from instead — the same name, shot on the date the name gives.
        </p>
        {truncated && <p className="modal-warn">Only the first {fmt(cap)} are listed — apply, then open this again for the rest.</p>}

        <div className="aside-body">
          {matched.length > 0 && (
            <section className="aside-group" aria-label="Source found">
              <div className="aside-group-head">
                <h3>Source found · {fmt(matched.length)}</h3>
                <button
                  type="button"
                  className="link-btn"
                  disabled={busy}
                  onClick={() => setOff(off.size ? new Set() : new Set(matched.map((x) => x.id)))}
                >
                  {off.size ? "Tick all" : "Untick all"}
                </button>
              </div>
              <div className="recap-table-wrap aside-table-wrap">
                <table className="recap-table aside-table">
                  <thead>
                    <tr>
                      <th scope="col">
                        <span className="sr-only">Copy</span>
                      </th>
                      <th scope="col">Export</th>
                      <th scope="col">Source clip</th>
                      <th scope="col">Shot</th>
                      <th scope="col">Position</th>
                    </tr>
                  </thead>
                  <tbody>
                    {matched.map((x) => {
                      const s = x.source!;
                      const on = !off.has(x.id);
                      return (
                        <tr key={x.id} className={on ? undefined : "is-skipped"}>
                          <td>
                            <input
                              type="checkbox"
                              checked={on}
                              disabled={busy}
                              onChange={() => toggle(x.id)}
                              aria-label={`Copy the position to ${x.filename}`}
                            />
                          </td>
                          <td>
                            <span className="aside-file" title={x.filename}>
                              {x.filename}
                            </span>
                            <span className="hint aside-sub">exported {day(x.captured_at)}</span>
                          </td>
                          <td>
                            <span className="aside-file" title={s.rel_path}>
                              {pathTail(s.rel_path)}
                            </span>
                          </td>
                          <td className="aside-nowrap">{day(s.captured_at)}</td>
                          <td>
                            {s.name ? (
                              <strong>{s.name.split(",")[0]}</strong>
                            ) : (
                              <span className="aside-coord">
                                {s.lat.toFixed(4)}, {s.lon.toFixed(4)}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {looseFolders.length > 0 && (
            <section className="aside-group" aria-label="No source">
              <div className="aside-group-head">
                <h3>No source in the library · {fmt(loose.length)}</h3>
              </div>
              <p className="hint">
                Nothing is suggested for these: their hours are the export’s. Place each folder by hand.
              </p>
              <ul className="aside-folders">
                {looseFolders.map((f) => {
                  const ambiguous = f.rows.filter((x) => x.reason === "ambiguous").length;
                  return (
                    <li key={f.id}>
                      <span className="aside-folder-name" title={f.name}>
                        {f.name}
                      </span>
                      <span className="hint">
                        {fmt(f.rows.length)} · exported {formatCaptureSpan(f.rows[0].captured_at, f.rows[f.rows.length - 1].captured_at)}
                        {ambiguous > 0 ? ` · ${fmt(ambiguous)} with clips by that name in different places` : ""}
                      </span>
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={busy}
                        onClick={() => onPlaceLoose({ id: f.id, name: f.name }, f.rows)}
                      >
                        Place {fmt(f.rows.length)}…
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </div>

        {error && <p className="modal-warn">{error}</p>}
        <div className="modal-actions">
          <span className="hint recap-foot-note">
            Recorded as a suggestion: in Winnow only, never written into the files.
          </span>
          <button className="btn" onClick={onClose} disabled={busy}>
            {matched.length ? "Cancel" : "Close"}
          </button>
          {matched.length > 0 && (
            <button className="btn btn-primary" onClick={() => void apply()} disabled={busy || !chosen.length}>
              {busy ? "Working…" : `Copy ${fmt(chosen.length)} ${chosen.length === 1 ? "position" : "positions"}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
