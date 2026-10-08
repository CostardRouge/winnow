"use client";

// Settings › Pipeline › Dates & places › "GPS track" — the UI half of
// lib/trackImport.ts (migration 0047).
//
// Drop a Polarsteps export (locations.json + trip.json), a GPX, or a JSON list
// of {lat, lon, time}: every live frame of the track's span that has no
// position takes the track's at its instant, and the zone it was in for its
// capture day. PREVIEW reads only and shows the report; APPLY records the
// import, which Undo takes back exactly. A frame whose own file placed it is
// never moved — when the track disagrees by more than 25 km at that instant it
// is listed as a conflict, the signature of a camera clock set wrong.
import { useCallback, useEffect, useRef, useState } from "react";
import { Spinner } from "../../../ui";
import { CAPTURE_DAYS_EVENT } from "./CaptureDaysSection";
import { fetchJson } from "@/lib/fetchJson";
import type { TrackImportReport, TrackImportRow } from "@/lib/trackImport";

const n = (v: number | undefined) => (v ?? 0).toLocaleString();
const date = (iso: string) => iso.slice(0, 10);

export default function TrackImportSection() {
  const [files, setFiles] = useState<File[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [report, setReport] = useState<TrackImportReport | null>(null);
  const [imports, setImports] = useState<TrackImportRow[] | null>(null);
  const input = useRef<HTMLInputElement>(null);

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

  async function send(apply: boolean) {
    if (!files.length) return;
    setBusy(true);
    setMsg(null);
    try {
      const fd = new FormData();
      for (const f of files) fd.append("files", f);
      if (name.trim()) fd.set("name", name.trim());
      if (apply) fd.set("apply", "true");
      const r = await fetchJson<{ report: TrackImportReport }>("/api/pipeline/track-import", {
        method: "POST",
        body: fd,
      });
      setReport(r.report);
      if (apply) {
        setFiles([]);
        if (input.current) input.current.value = "";
        await loadImports();
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
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="pl-section" aria-labelledby="track-import-title">
      <h2 id="track-import-title" className="section-head">
        GPS track
      </h2>
      <p className="hint card-rules">
        A track recorded beside the cameras — a Polarsteps export
        (<code>locations.json</code> + <code>trip.json</code>), a GPX — places
        every frame of its span that has no position, by its capture instant,
        and gives its capture day the zone it was in. Frames placed by their own
        file are never moved; human-set positions are kept. Nothing is written
        into an original, and an applied import can be undone.
      </p>

      <div className="filterbar">
        <input
          ref={input}
          type="file"
          multiple
          accept=".json,.gpx,application/json,application/gpx+xml"
          onChange={(e) => {
            setFiles(Array.from(e.target.files ?? []));
            setReport(null);
          }}
        />
        <input
          type="text"
          className="input"
          placeholder="Name (optional)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Import name"
        />
        <button type="button" className="btn" disabled={busy || !files.length} onClick={() => send(false)}>
          Preview
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !files.length || !report || report.apply}
          title={!report ? "Preview first" : undefined}
          onClick={() => send(true)}
        >
          Apply
        </button>
        {busy && <Spinner sm />}
      </div>

      {msg && <p className="hint">{msg}</p>}
      {report && <TrackReport report={report} />}

      {imports && imports.length > 0 && (
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
              {imports.map((t) => (
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

// The frames a track skips are the ones indexed before the local-day repair:
// re-reading THEIR date tags (the span ± a day, not the whole library) is what
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
      // The day section above polls it and shows its progress and report.
      window.dispatchEvent(new CustomEvent(CAPTURE_DAYS_EVENT, { detail: queued.job_id }));
      setState("queued");
    } catch {
      setState("error");
    }
  }
  return (
    <p>
      {n(r.unclassified)} frame(s) in the span were indexed before the local-day repair: until
      their date tags are read again, a wall clock and a zoned time cannot be told apart, so they
      are skipped.{" "}
      {state === "queued" ? (
        <strong>Re-read queued — follow it in Local capture day above, then preview again.</strong>
      ) : (
        <button type="button" className="btn btn-sm" disabled={state === "busy"} onClick={go}>
          Re-read the dates of this span
        </button>
      )}
      {state === "error" && " The re-read could not be queued."}
    </p>
  );
}

function TrackReport({ report: r }: { report: TrackImportReport }) {
  const located = r.located.interpolated + r.located.still + r.located.nearest;
  return (
    <div className="hint card-rules">
      <p>
        <strong>{r.apply ? `Applied “${r.name}”.` : `Preview of “${r.name}” — nothing was written.`}</strong>{" "}
        {n(r.points)} fixes{r.steps ? ` and ${n(r.steps)} steps` : ""}, {date(r.span.start)} →{" "}
        {date(r.span.end)}. Of {n(r.inSpan)} frames in that span: <strong>{n(located)}</strong>{" "}
        placed by the track ({n(r.located.interpolated)} between two fixes on the move,{" "}
        {n(r.located.still)} between two fixes at the same spot (within {r.match.maxStillKm} km,{" "}
        {r.match.maxStillHours} h), {n(r.located.nearest)} on the nearest fix within{" "}
        {r.match.maxNearestMin} min), {n(r.zonedOnly)} in a gap given only its
        zone, {n(r.unmatched)} left as they were; {n(r.ownPosition)} already placed by their own
        file, {n(r.manualKept)} by hand and {n(r.inferredKept)} by a folder suggestion — kept.{" "}
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
