"use client";

// Step 2 of Settings › Pipeline › Dates & places — the UI half of
// lib/trackImport.ts (migration 0047).
//
// A Polarsteps export is TWO files, and a reader must not have to know it: the
// step shows one slot per file — the positions (locations.json, required) and
// the steps (trip.json, which carry each day's time zone and the trip's name) —
// and says what each chosen file is the moment it is chosen
// (lib/trackFiles.ts), routing a file to its slot whichever picker took it. A
// GPX is the other source, one slot of its own. The import is recorded under
// the trip's or the GPX's own title (else its first day): a label for the
// history, nothing else, so there is no field to fill in.
//
// PREVIEW reads only and shows the report; APPLY records the import, which
// Undo takes back exactly. A frame whose own file placed it is never moved —
// when the track disagrees by more than 25 km at that instant it is listed as
// a conflict, the signature of a camera clock set wrong.
import { useCallback, useEffect, useState } from "react";
import { Spinner } from "../../../ui";
import { CAPTURE_DAYS_EVENT } from "./CaptureDaysSection";
import { fetchJson } from "@/lib/fetchJson";
import { identifyTrackFile, type TrackFileInfo, type TrackFileSlot } from "@/lib/trackFiles";
import type { TrackImportReport, TrackImportRow } from "@/lib/trackImport";

const n = (v: number | undefined) => (v ?? 0).toLocaleString();
const date = (iso: string) => iso.slice(0, 10);
const day = (ms: number | null) =>
  ms == null ? "?" : new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

type Chosen = { file: File; info: TrackFileInfo };
type Source = "polarsteps" | "gpx";

const SLOTS: Record<Source, { slot: TrackFileSlot; label: string; expects: string; optional?: string }[]> = {
  polarsteps: [
    { slot: "positions", label: "Positions", expects: "locations.json" },
    { slot: "steps", label: "Steps", expects: "trip.json", optional: "each day’s time zone and the trip’s name" },
  ],
  gpx: [{ slot: "gpx", label: "Track", expects: "a .gpx file" }],
};

export default function TrackImportSection({
  toRead,
  onChanged,
}: {
  /** Times step 1 has not read yet — the frames a preview would skip. */
  toRead: number;
  onChanged: () => void | Promise<void>;
}) {
  const [source, setSource] = useState<Source>("polarsteps");
  const [chosen, setChosen] = useState<Partial<Record<TrackFileSlot, Chosen>>>({});
  const [refused, setRefused] = useState<TrackFileInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [report, setReport] = useState<TrackImportReport | null>(null);
  const [imports, setImports] = useState<TrackImportRow[] | null>(null);

  const loadImports = useCallback(async () => {
    try {
      const r = await fetchJson<{ imports: TrackImportRow[] }>("/api/pipeline/track-import");
      setImports(r.imports);
    } catch (e) {
      setMsg((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void loadImports();
  }, [loadImports]);

  // Whatever picker took them, each file goes to the slot it IS.
  async function take(files: FileList | null) {
    if (!files?.length) return;
    const next = { ...chosen };
    const bad: TrackFileInfo[] = [];
    for (const file of Array.from(files)) {
      const info = identifyTrackFile(file.name, await file.text());
      if (!info.ok) bad.push(info);
      else {
        next[info.slot] = { file, info };
        if (info.slot === "gpx") setSource("gpx");
        else setSource("polarsteps");
      }
    }
    setChosen(next);
    setRefused(bad);
    setReport(null);
    setMsg(null);
  }

  const slots = SLOTS[source];
  const files = slots.map((s) => chosen[s.slot]).filter((c): c is Chosen => c != null);
  const ready = source === "gpx" ? !!chosen.gpx : !!chosen.positions;

  async function send(apply: boolean) {
    if (!ready) return;
    setBusy(true);
    setMsg(null);
    try {
      const fd = new FormData();
      for (const c of files) fd.append("files", c.file);
      if (apply) fd.set("apply", "true");
      const r = await fetchJson<{ report: TrackImportReport }>("/api/pipeline/track-import", {
        method: "POST",
        body: fd,
      });
      setReport(r.report);
      if (apply) {
        setChosen({});
        await loadImports();
        void onChanged();
      }
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revert(id: number) {
    if (!window.confirm("Undo this import? The positions and zones it wrote are taken back.")) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetchJson<{ unplaced: number; unzoned: number }>(
        `/api/pipeline/track-import/${id}/revert`,
        { method: "POST" },
      );
      setMsg(`Undone: ${n(r.unplaced)} position(s) and ${n(r.unzoned)} zone(s) taken back.`);
      setReport(null);
      await loadImports();
      void onChanged();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const applied = (imports?.length ?? 0) > 0;

  return (
    <section className="flow-step" data-state={applied ? "done" : "todo"} aria-labelledby="track-import-title">
      <header className="flow-step-head">
        <span className="flow-num" aria-hidden>
          {applied ? "✓" : "2"}
        </span>
        <h2 id="track-import-title">Place frames from a GPS track</h2>
        <span className="flow-state">{applied ? `${imports!.length} applied` : "Optional"}</span>
      </header>
      <p className="hint">
        For frames with no position of their own — a camera without GPS. A track recorded beside
        it places each one by its capture instant and gives its day the zone it was in. Frames
        placed by their own file are never moved, hand-set positions are kept, nothing is written
        into an original, and an import can be undone.
      </p>

      {toRead > 0 && (
        <p className="flow-warn">
          Step 1 first: {n(toRead)} capture time(s) are not read yet, and the frames among them
          would be skipped.
        </p>
      )}

      <div className="flow-actions" role="group" aria-label="Source">
        {(["polarsteps", "gpx"] as const).map((s) => (
          <button
            key={s}
            type="button"
            className={`btn btn-sm${source === s ? " btn-primary" : ""}`}
            aria-pressed={source === s}
            onClick={() => {
              setSource(s);
              setReport(null);
            }}
          >
            {s === "polarsteps" ? "Polarsteps export" : "GPX file"}
          </button>
        ))}
      </div>

      <div className="flow-slots">
        {slots.map((s) => {
          const c = chosen[s.slot];
          const info = c?.info.ok ? c.info : null;
          return (
            <label key={s.slot} className="flow-slot" data-filled={info ? "" : undefined}>
              <span className="flow-slot-label">
                {s.label}
                <span className="hint">{s.optional ? "recommended" : "required"}</span>
              </span>
              <span className="flow-slot-body">
                {info ? (
                  <>
                    <strong>✓ {c!.file.name}</strong>{" "}
                    <span className="hint">
                      {info.slot === "steps"
                        ? `${info.title ? `“${info.title}” · ` : ""}${n(info.count)} steps`
                        : `${n(info.count)} positions`}{" "}
                      · {day(info.from)} → {day(info.to)}
                    </span>
                  </>
                ) : (
                  <span className="hint">
                    {s.expects}
                    {s.optional ? ` — ${s.optional}` : ""}
                  </span>
                )}
              </span>
              <span className="btn btn-sm">{info ? "Replace" : "Choose…"}</span>
              <input
                type="file"
                multiple
                className="sr-only"
                accept=".json,.gpx,application/json,application/gpx+xml"
                onChange={(e) => {
                  void take(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
          );
        })}
      </div>
      {source === "polarsteps" && chosen.positions && !chosen.steps && (
        <p className="hint">
          Without trip.json each day’s zone is read from its positions alone, and the import is
          named after its first day.
        </p>
      )}
      {refused.map((r) => (
        <p key={r.name} className="flow-warn">
          {r.name}: {!r.ok && r.error}.
        </p>
      ))}

      <div className="flow-actions">
        <button type="button" className="btn" disabled={busy || !ready} onClick={() => send(false)}>
          Preview
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !ready || !report || report.apply}
          title={!report ? "Preview first" : undefined}
          onClick={() => send(true)}
        >
          Apply
        </button>
        {busy && <Spinner sm />}
        {!report && ready && <span className="hint">Preview writes nothing.</span>}
      </div>

      {msg && <p className="hint">{msg}</p>}
      {report && <TrackReport report={report} />}

      {applied && (
        <div className="vol-table-wrap">
          <table className="vol-table">
            <thead>
              <tr>
                <th scope="col">Applied import</th>
                <th scope="col">Span</th>
                <th scope="col">Placed</th>
                <th scope="col">Zoned</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {imports!.map((t) => (
                <tr key={t.id}>
                  <td>
                    {t.name} <span className="hint">· {t.kind}</span>
                  </td>
                  <td>
                    {date(t.span_start)} → {date(t.span_end)}
                  </td>
                  <td>{n(t.placed)}</td>
                  <td>{n(t.zoned)}</td>
                  <td>
                    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => revert(t.id)}>
                      Undo
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// The frames a track skips are the ones whose time step 1 has not read:
// reading THEIR date tags (the span ± a day, not the whole library) is what
// lets the next preview place them.
function RereadSpan({ report: r }: { report: TrackImportReport }) {
  const [state, setState] = useState<"idle" | "busy" | "queued" | "error">("idle");
  const DAY = 86_400_000;
  async function go() {
    setState("busy");
    try {
      const queued = await fetchJson<{ job_id: string }>("/api/pipeline/capture-days", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apply: true,
          reread: true,
          from: new Date(Date.parse(r.span.start) - DAY).toISOString(),
          to: new Date(Date.parse(r.span.end) + DAY).toISOString(),
        }),
      });
      // Step 1 polls it and shows its progress and report.
      window.dispatchEvent(new CustomEvent(CAPTURE_DAYS_EVENT, { detail: queued.job_id }));
      setState("queued");
    } catch {
      setState("error");
    }
  }
  return (
    <p className="flow-warn">
      {n(r.unclassified)} frame(s) of this span were skipped: their time is not read yet (step 1).{" "}
      {state === "queued" ? (
        <strong>Reading queued — follow it in step 1, then preview again.</strong>
      ) : (
        <button type="button" className="btn btn-sm" disabled={state === "busy"} onClick={go}>
          Read the dates of this span only
        </button>
      )}
      {state === "error" && " The read could not be queued."}
    </p>
  );
}

function TrackReport({ report: r }: { report: TrackImportReport }) {
  const located = r.located.interpolated + r.located.still + r.located.nearest;
  return (
    <div className="hint card-rules">
      <p>
        <strong>{r.apply ? `Applied “${r.name}”.` : `Preview of “${r.name}” — nothing was written.`}</strong>{" "}
        {n(r.points)} positions{r.steps ? ` and ${n(r.steps)} steps` : ""}, {date(r.span.start)} →{" "}
        {date(r.span.end)}. Of {n(r.inSpan)} frames in that span: <strong>{n(located)}</strong>{" "}
        placed by the track ({n(r.located.interpolated)} between two positions on the move,{" "}
        {n(r.located.still)} between two at the same spot (within {r.match.maxStillKm} km,{" "}
        {r.match.maxStillHours} h), {n(r.located.nearest)} on the nearest within{" "}
        {r.match.maxNearestMin} min), {n(r.zonedOnly)} in a gap given only its zone,{" "}
        {n(r.unmatched)} left as they were; {n(r.ownPosition)} already placed by their own file,{" "}
        {n(r.manualKept)} by hand and {n(r.inferredKept)} by a folder suggestion — kept.{" "}
        <strong>{n(r.daysChanged)}</strong> frame(s) change capture day.
      </p>
      {r.unclassified > 0 && <RereadSpan report={r} />}
      {r.conflictCount > 0 && (
        <details>
          <summary>
            {n(r.conflictCount)} frame(s) placed by their own file more than 25 km from the track at
            that instant — a camera clock set wrong?
          </summary>
          <ul>
            {r.conflicts.slice(0, 20).map((c) => (
              <li key={c.id}>
                <a href={`/api/assets/${c.id}/thumb`} target="_blank" rel="noreferrer">
                  {c.filename}
                </a> · {c.device ?? "unknown body"} ·{" "}
                {c.at.replace("T", " ").slice(0, 16)} UTC · {n(c.km)} km
              </li>
            ))}
          </ul>
        </details>
      )}
      {r.days.length > 0 && (
        <details>
          <summary>Per day ({n(r.days.length)} days)</summary>
          <div className="vol-table-wrap">
            <table className="vol-table">
              <thead>
                <tr>
                  <th scope="col">Local day</th>
                  <th scope="col">Placed by the track</th>
                  <th scope="col">Zone only</th>
                  <th scope="col">Own position</th>
                </tr>
              </thead>
              <tbody>
                {r.days.map((d) => (
                  <tr key={d.day}>
                    <td>{d.day}</td>
                    <td>{n(d.located)}</td>
                    <td>{n(d.zoned)}</td>
                    <td>{n(d.own)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}
