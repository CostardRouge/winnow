"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { fetchJson } from "@/lib/fetchJson";
import type { TraceResponse, TraceSource } from "@/lib/unplacedTypes";
import { useOverlayDismiss } from "@/app/useOverlayDismiss";

// "Follow a track…", step 1 (docs/UNPLACED.md §11): what the track would be
// made of around the card's hours — the applied GPS imports whose kept fixes
// fall there, and the located frames shot then, per camera body — each a
// checkbox. A body that is not the photographer's (a friend's camera) is the
// reason they are separate. Nothing is uploaded here: a GPX or a Polarsteps
// export goes in through Settings › Pipeline › Dates & places, the one import
// screen, and the link says so instead of growing a second one. "Show the
// stops" asks the server to match the card's frames against the chosen
// sources and hands the answer to the host, which opens the stops dialog.

const SETTINGS = "/settings/pipeline/capture#track-import-title";

const fmt = (n: number) => n.toLocaleString("en-GB");
const day = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

const sourceKey = (s: TraceSource) => (s.kind === "import" ? `i:${s.id}` : `m:${s.model ?? ""}`);

export default function TraceSourcesModal({
  sessionId,
  from,
  to,
  label,
  onClose,
  onReady,
}: {
  sessionId: number;
  from: string;
  to: string;
  /** "2 Aug 2024 · 08:40–19:55" — the card's window, in words. */
  label: string;
  onClose: () => void;
  onReady: (trace: TraceResponse) => void;
}) {
  const [sources, setSources] = useState<TraceSource[] | null>(null);
  const [on, setOn] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const backdrop = useOverlayDismiss<HTMLDivElement>(() => {
    if (!busy) onClose();
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  // pg hands the window over in microseconds and an ISO instant carries
  // milliseconds: the end is rounded UP by one, or a last frame stamped
  // …:00.123456 falls outside a window that ends at …:00.123.
  const fromIso = new Date(from).toISOString();
  const toIso = new Date(Date.parse(to) + 1).toISOString();

  useEffect(() => {
    const qs = new URLSearchParams({ from: fromIso, to: toIso });
    fetchJson<{ sources: TraceSource[] }>(`/api/assets/unplaced/trace?${qs}`)
      .then((r) => {
        setSources(r.sources);
        // Every source starts ticked: the human unticks what is not theirs.
        setOn(new Set(r.sources.map(sourceKey)));
      })
      .catch((e) => setError((e as Error).message));
  }, [fromIso, toIso]);

  async function show() {
    if (!sources) return;
    setBusy(true);
    setError(null);
    try {
      const chosen = sources.filter((s) => on.has(sourceKey(s)));
      const trace = await fetchJson<TraceResponse>("/api/assets/unplaced/trace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          from: fromIso,
          to: toIso,
          imports: chosen.flatMap((s) => (s.kind === "import" ? [s.id] : [])),
          models: chosen.flatMap((s) => (s.kind === "frames" ? [s.model] : [])),
        }),
      });
      onReady(trace);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const imports = sources?.filter((s) => s.kind === "import") ?? [];
  const frames = sources?.filter((s) => s.kind === "frames") ?? [];
  const toggle = (k: string) =>
    setOn((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  return (
    <div className="modal-overlay" role="presentation" {...backdrop}>
      <div className="modal trace-modal" role="dialog" aria-modal="true" aria-label="Follow a track">
        <h2 className="modal-title">Follow a track</h2>
        <p className="hint">
          Place each frame where the track was at the minute it was shot. What the
          track is made of, for {label}:
        </p>

        {!sources && !error && <p className="hint">Looking for tracks…</p>}

        {sources && (
          <>
            <fieldset className="trace-group">
              <legend className="modal-label">Imported tracks</legend>
              {imports.length === 0 ? (
                <p className="hint">No imported track covers these hours.</p>
              ) : (
                imports.map((s) =>
                  s.kind === "import" ? (
                    <label key={sourceKey(s)} className="export-check trace-source">
                      <input type="checkbox" checked={on.has(sourceKey(s))} onChange={() => toggle(sourceKey(s))} disabled={busy} />
                      <span>
                        <strong>
                          {s.import_kind === "polarsteps" ? "Polarsteps" : s.import_kind.toUpperCase()} · “{s.name}”
                        </strong>
                        <span className="hint">
                          {" "}
                          {day.format(new Date(s.span_start))} – {day.format(new Date(s.span_end))} · {fmt(s.points)} fixes in these hours
                        </span>
                      </span>
                    </label>
                  ) : null,
                )
              )}
            </fieldset>

            <fieldset className="trace-group">
              <legend className="modal-label">Located frames in the library</legend>
              {frames.length === 0 ? (
                <p className="hint">None shot in these hours — the phone was off or left behind.</p>
              ) : (
                frames.map((s) =>
                  s.kind === "frames" ? (
                    <label key={sourceKey(s)} className="export-check trace-source">
                      <input type="checkbox" checked={on.has(sourceKey(s))} onChange={() => toggle(sourceKey(s))} disabled={busy} />
                      <span>
                        <strong>{s.model ?? "No camera named"}</strong>
                        <span className="hint"> · {fmt(s.points)} located {s.points === 1 ? "frame" : "frames"}</span>
                      </span>
                    </label>
                  ) : null,
                )
              )}
              {frames.length > 1 && (
                <p className="hint">Untick a body that was not with you — a friend’s camera elsewhere would pull frames to it.</p>
              )}
            </fieldset>

            <div className="trace-import-note">
              Have a GPX or a Polarsteps export for these dates?{" "}
              <Link href={SETTINGS} target="_blank" rel="noopener">
                Import it in Settings › Pipeline › Dates &amp; places ↗
              </Link>
              <span className="hint"> Then come back: this list will name it.</span>
            </div>
          </>
        )}

        {error && <p className="modal-warn">{error}</p>}

        <div className="modal-actions">
          <span className="hint recap-foot-note">Nothing is written yet.</span>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void show()}
            disabled={busy || !sources || on.size === 0}
          >
            {busy ? "Matching…" : "Show the stops"}
          </button>
        </div>
      </div>
    </div>
  );
}
