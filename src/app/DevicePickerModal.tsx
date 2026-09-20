"use client";

// "Set camera body…" — the bulk attribution action, from inside the grids.
//
// Pipeline › Devices clears the backlog by folder, which is the right shape for
// three hundred clips at once. This is the other half: the media you are
// already looking at, in the gallery or a session, given a body without leaving
// the grid. Same endpoint, same rule.
//
// THE RULE, stated on screen because it decides what the button does: an
// attribution only ever fills a HOLE. Media in the selection that already carry
// a body — from their own EXIF or from an earlier attribution — are counted and
// left alone. That is not timidity: `assets.device` is read from the file on
// every re-index and the file always wins (cf. lib/indexer.ts), so a hand-made
// override of a real EXIF value would silently revert the next time the clip's
// mtime changed. A wrong body that a camera actually wrote is a different
// problem, and it is not solved by letting this dialog lie.
import { useEffect, useState } from "react";
import { Spinner } from "./ui";
import { friendlyCameraName } from "@/lib/cameraLabels";
import { fetchJson } from "@/lib/fetchJson";
import type { KnownBody } from "@/lib/deviceAttribution";

export default function DevicePickerModal({
  ids,
  withoutBody,
  onClose,
  onApplied,
}: {
  /** The whole selection — the dialog itself works out what it can touch. */
  ids: number[];
  /** How many of them carry no body yet, computed by the caller from rows it
   *  already has. The dialog never refetches the selection to say this. */
  withoutBody: number;
  onClose: () => void;
  onApplied: (message: string, ids: number[], body: KnownBody) => void;
}) {
  const [bodies, setBodies] = useState<KnownBody[] | null>(null);
  const [chosen, setChosen] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The bodies the library already holds, busiest first — the same list the
  // Devices page offers, from the same endpoint. Never a free-text field: the
  // value written has to be one the gear dimension is ALREADY grouping on, or
  // the media land on a card of their own (cf. lib/deviceAttribution.ts).
  useEffect(() => {
    let live = true;
    fetchJson<{ bodies: KnownBody[] }>("/api/pipeline/device-attribution")
      .then((d) => {
        if (!live) return;
        setBodies(d.bodies);
        setChosen((c) => c || d.bodies[0]?.device || "");
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const body = bodies?.find((b) => b.device === chosen);
  const skipped = ids.length - withoutBody;

  async function apply() {
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetchJson<{ updated: number; skipped: number }>(
        "/api/pipeline/device-attribution",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ids,
            device: body.device,
            camera_model: body.camera_model ?? undefined,
          }),
        },
      );
      onApplied(
        res.updated
          ? `${res.updated.toLocaleString()} media assigned to ${friendlyCameraName(body.device)}`
          : "Nothing to assign — every selected medium already has a body",
        ids,
        body,
      );
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={() => !busy && onClose()}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Set camera body"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3 className="modal-title">Set camera body</h3>
        <div className="modal-body">
          {error && <p className="dev-pick-warn">{error}</p>}

          {withoutBody === 0 ? (
            <p>
              All {ids.length.toLocaleString()} selected media already carry a
              camera body. Nothing here would change — an attribution only fills
              a gap, it never overwrites what a file declares.
            </p>
          ) : (
            <>
              <p>
                <strong>{withoutBody.toLocaleString()}</strong> of the{" "}
                {ids.length.toLocaleString()} selected media carry no camera
                body. Give them one:
              </p>
              {bodies == null ? (
                <Spinner sm />
              ) : bodies.length === 0 ? (
                <p className="dev-pick-warn">
                  The library holds no camera body to copy yet — nothing has
                  readable EXIF. Index some media from a camera first.
                </p>
              ) : (
                <div className="dev-pick-list" role="radiogroup" aria-label="Camera body">
                  {bodies.map((b) => (
                    <label
                      key={b.device}
                      className={`dev-pick-row${chosen === b.device ? " is-on" : ""}`}
                    >
                      <input
                        type="radio"
                        name="device-body"
                        checked={chosen === b.device}
                        onChange={() => setChosen(b.device)}
                      />
                      <span className="dev-pick-name">
                        {friendlyCameraName(b.device)}
                      </span>
                      <span className="dev-pick-raw">{b.device}</span>
                      <span className="dev-pick-count">
                        {b.count.toLocaleString()}
                      </span>
                    </label>
                  ))}
                </div>
              )}
              {skipped > 0 && (
                <p className="dev-pick-note">
                  The other {skipped.toLocaleString()} already have a body and
                  will not be touched — the file always wins over an
                  attribution, so an override here would revert on the next
                  re-index.
                </p>
              )}
            </>
          )}
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void apply()}
            disabled={busy || !body || withoutBody === 0}
          >
            {busy ? (
              <Spinner sm />
            ) : (
              `Assign ${withoutBody.toLocaleString()}`
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
