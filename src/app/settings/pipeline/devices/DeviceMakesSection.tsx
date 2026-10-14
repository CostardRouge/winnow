"use client";

// Settings › Pipeline › Devices — "one camera, two names", the UI half of
// lib/deviceMakes.ts.
//
// Some cameras write their Make in a still and leave it out of a video (the
// Ray-Ban Meta glasses: `Meta AI Ray-Ban Meta Smart Glasses 2` on the photos,
// `Ray-Ban Meta Smart Glasses 2` on the clips), and the shelf drew two bodies.
// The indexer joins them at the end of every scan for the models it read; this
// step is the one click for what was indexed before. It is only on the page
// while there is something to join — and right after a join, to say what moved.
import { useEffect, useState } from "react";
import { Spinner } from "../../../ui";
import { fetchJson } from "@/lib/fetchJson";
import type { JoinReport, MakelessReport } from "@/lib/deviceTypes";

const n = (v: number) => v.toLocaleString("en-GB");

export default function DeviceMakesSection({
  onChanged,
}: {
  /** Called once a join is applied: the folder list below may have moved. */
  onChanged: () => void | Promise<void>;
}) {
  const [found, setFound] = useState<MakelessReport | null>(null);
  const [done, setDone] = useState<JoinReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    fetchJson<MakelessReport>("/api/pipeline/device-makes")
      .then(setFound)
      .catch((e: Error) => setMsg(e.message));
  }, []);

  async function join() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetchJson<JoinReport>("/api/pipeline/device-makes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apply: true }),
      });
      setDone(r);
      setFound({ pairs: [], ambiguous: r.ambiguous });
      await onChanged();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const pairs = found?.pairs ?? [];
  const ambiguous = found?.ambiguous ?? [];
  if (!done && !msg && found && !pairs.length && !ambiguous.length) return null;
  if (!found && !msg) return null;
  const state = pairs.length ? "todo" : "done";
  const media = pairs.reduce((s, p) => s + p.media, 0);

  return (
    <section className="flow-step" data-state={state} aria-labelledby="device-makes-title">
      <header className="flow-step-head">
        <span className="flow-num" aria-hidden>
          {state === "done" ? "✓" : "="}
        </span>
        <h2 id="device-makes-title">One camera, two names</h2>
        <span className="flow-state">{state === "todo" ? "To do" : "Done"}</span>
      </header>
      <p className="hint">
        Some cameras write their maker in a photo and leave it out of a video, so one camera
        shows up as two bodies. A name is joined only when the model’s other files spell it
        one way with its maker; nothing is guessed and no original is touched. New files join
        on their own as they are indexed.
      </p>

      {pairs.length > 0 && (
        <>
          <ul className="dev-makes">
            {pairs.map((p) => (
              <li key={p.model}>
                <code>{p.model}</code> <span className="hint">({n(p.media)} media)</span> →{" "}
                <code>{p.full}</code>
              </li>
            ))}
          </ul>
          <div className="flow-actions">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void join()}>
              {busy ? <Spinner sm /> : null} Join {pairs.length === 1 ? "this body" : `${n(pairs.length)} bodies`}
            </button>
            <span className="hint">
              {n(media)} media move to the full name. Whose camera it is carries over.
            </span>
          </div>
        </>
      )}

      {done && (
        <p role="status">
          <strong>Joined.</strong> {n(done.moved)} media now carry the full name
          {done.ownersMoved > 0 && ` — the ownership answer came with them`}
          {done.ownersDropped > 0 && ` — the full name’s own ownership answer was kept`}.
        </p>
      )}

      {ambiguous.length > 0 && (
        <details className="card-rules">
          <summary>
            {n(ambiguous.length)} model{ambiguous.length === 1 ? "" : "s"} two makers claim — left as
            they are
          </summary>
          <ul>
            {ambiguous.map((a) => (
              <li key={a.model}>
                <code>{a.model}</code> ({n(a.media)} media): {a.fulls.map((f) => `“${f}”`).join(", ")}
              </li>
            ))}
          </ul>
        </details>
      )}

      {msg && <p className="hint">{msg}</p>}
    </section>
  );
}
