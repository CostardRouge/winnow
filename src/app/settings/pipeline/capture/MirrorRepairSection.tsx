"use client";

// Step 3 of Settings › Pipeline › Dates & places — the UI half of
// lib/mirrorRepair.ts (docs/SILENT-LIMITS-AUDIT.md G1).
//
// Until 2026-10-09 the GPS write-back put every hand-placed pin West or South
// into its original MIRRORED (exiftool-vendored takes the hemisphere from the
// sign, and the values were unsigned), and the next scan read the mirror back:
// Australian folders at 33° N, Brittany in Seine-et-Marne. This step finds the
// placed folders the cameras' own fixes contradict, shows each one with where
// it is and where it goes, and corrects them in one gesture — the rows at
// once, the original files through the GPS-write queue at its own pace.
//
// The preview runs on open (a read, a couple of seconds); the rules are
// printed, and a folder the evidence cannot settle is listed, never guessed.
import { useCallback, useEffect, useState } from "react";
import { Spinner } from "../../../ui";
import { fetchJson } from "@/lib/fetchJson";
import type { MirrorGroup, MirrorReport } from "@/lib/mirrorRepair";

const n = (v: number) => v.toLocaleString("en-GB");
const coord = (p: { lat: number; lon: number }) => `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`;
const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const span = (g: MirrorGroup) => (day(g.t0) === day(g.t1) ? day(g.t0) : `${day(g.t0)} – ${day(g.t1)}`);

export default function MirrorRepairSection({ onChanged }: { onChanged: () => void }) {
  const [preview, setPreview] = useState<MirrorReport | null>(null);
  const [done, setDone] = useState<MirrorReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setPreview(await fetchJson<MirrorReport>("/api/pipeline/mirror-repair"));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function apply() {
    setBusy(true);
    try {
      const r = await fetchJson<MirrorReport>("/api/pipeline/mirror-repair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apply: true }),
      });
      setDone(r);
      await load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const mirrored = preview?.groups.filter((g) => g.verdict === "mirrored") ?? [];
  const unsettled = preview?.groups.filter((g) => g.verdict !== "mirrored") ?? [];
  const todo = !!preview && (preview.mirrored > 0 || preview.filesToRewrite > 0);
  const state = !preview ? "loading" : todo ? "todo" : "done";

  return (
    <section className="flow-step" data-state={state} aria-labelledby="mirror-title">
      <header className="flow-step-head">
        <span className="flow-num" aria-hidden>
          {state === "done" ? "✓" : "3"}
        </span>
        <h2 id="mirror-title">Repair mirrored positions</h2>
        <span className="flow-state">
          {state === "todo" ? "To do" : state === "done" ? "Done" : ""}
        </span>
      </header>
      <p className="hint">
        Until 9 Oct 2026, a pin placed by hand West of Greenwich or South of the equator was
        written into its original in the opposite hemisphere, and the next scan read it back:
        Australian folders ended up at 33° N, Brittany inland. A placed folder is corrected when,
        measured against the positions the cameras recorded themselves on the same days
        (median distance), a sign flip of its point lies within 100 km of them while the point as
        stored lies at least three times farther, plus 100 km.
      </p>

      {error && <p className="hint">{error}</p>}
      {state === "loading" && !error && <Spinner />}

      {done && (
        <p className="hint card-rules">
          <strong>Repaired.</strong> {n(done.mirrored)} media put back in their hemisphere;{" "}
          {n(done.filesToRewrite)} original file(s) queued for a rewrite (Settings › Pipeline ›
          Failures lists any that refuse). Place names and capture days follow.
        </p>
      )}

      {state === "todo" && preview && (
        <>
          <p>
            <strong>{n(preview.mirrored)}</strong> media in {n(mirrored.length)} placed folder(s)
            are mirrored
            {preview.filesToRewrite > 0 && (
              <>
                , and <strong>{n(preview.filesToRewrite)}</strong> original file(s) hold a
                mirrored position
              </>
            )}
            .
          </p>
          {mirrored.length > 0 && (
            <div className="vol-table-wrap">
              <table className="vol-table">
                <thead>
                  <tr>
                    <th>Folder</th>
                    <th>Shot</th>
                    <th>Media</th>
                    <th>Now</th>
                    <th>Back to</th>
                  </tr>
                </thead>
                <tbody>
                  {mirrored.map((g) => (
                    <tr key={`${g.sessionId}:${g.from.lat}:${g.from.lon}`}>
                      <td title={g.folder}>{g.folder}</td>
                      <td>{span(g)}</td>
                      <td>{n(g.media)}</td>
                      <td title={`${n(g.storedKm ?? 0)} km from the cameras’ fixes (median)`}>{coord(g.from)}</td>
                      <td title={`${n(g.flippedKm ?? 0)} km from the cameras’ fixes (median)`}>{coord(g.to!)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flow-actions">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void apply()}>
              {busy ? "Repairing…" : preview.mirrored > 0 ? `Repair ${n(preview.mirrored)} media` : `Rewrite ${n(preview.filesToRewrite)} file(s)`}
            </button>
            <span className="hint">
              The rows at once; the originals through the GPS-write queue, signed this time.
            </span>
          </div>
        </>
      )}

      {state === "done" && !done && (
        <p>No placed folder contradicts the cameras’ own positions.</p>
      )}

      {unsettled.length > 0 && (
        <details className="card-rules hint">
          <summary>
            {n(unsettled.reduce((s, g) => s + g.media, 0))} placed media the evidence cannot settle
            · left as they are
          </summary>
          <p>
            No camera fix in their hours, or none near the point nor any of its flips. Check them
            on the map and place them again if they are wrong.
          </p>
          <div className="vol-table-wrap">
            <table className="vol-table">
              <tbody>
                {unsettled.map((g) => (
                  <tr key={`${g.sessionId}:${g.from.lat}:${g.from.lon}`}>
                    <td title={g.folder}>{g.folder}</td>
                    <td>{span(g)}</td>
                    <td>{n(g.media)}</td>
                    <td>{coord(g.from)}</td>
                    <td>
                      {g.verdict === "no_evidence"
                        ? "no camera fix"
                        : `${n(g.storedKm ?? 0)} km from the fixes`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}
