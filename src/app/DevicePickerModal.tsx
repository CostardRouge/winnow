"use client";

// "Set camera body…" — the bulk attribution action, from inside the grids.
//
// Pipeline › Devices clears the backlog by folder, which is the right shape for
// three hundred clips at once. This is the other half: the media you are
// already looking at, in the gallery or a session, given a body without leaving
// the grid. Same endpoint.
//
// Three things it can do, and the dialog says which one each button is:
//   • FILL — the default. Only the selected media that carry no body get one;
//     the rest are counted and left alone.
//   • REPLACE — opt-in, behind a checkbox that names how many media it touches.
//     For a file that is WRONG (a borrowed camera that kept its owner's name, an
//     app that stamps a generic model). It records 'override' (migration 0048),
//     the one provenance the indexer lets beat the file, so the correction
//     survives every re-index. What the file said is kept beside it and shown
//     in the viewer; nothing is written into the original.
//   • REVERT — put the media back to what their own files say. Offered only
//     when the selection holds something to revert (an override or an
//     attribution).
// Replacing is never the default and never implied by leaving a box unticked:
// the one write that can overwrite a camera's own value has to be asked for.
import { useEffect, useState } from "react";
import { Spinner } from "./ui";
import { friendlyCameraName } from "@/lib/cameraLabels";
import { fetchJson } from "@/lib/fetchJson";
import type { KnownBody } from "@/lib/deviceAttribution";
import type { DeviceChange } from "@/lib/deviceChange";

// The row rules (what each outcome does to a grid row) live in lib/deviceChange
// so both grids share them and a test covers them; re-exported for the hosts.
export {
  applyDeviceChange,
  deviceSelectionCounts,
  type DeviceChange,
} from "@/lib/deviceChange";

export default function DevicePickerModal({
  ids,
  withoutBody,
  revertible,
  onClose,
  onApplied,
}: {
  /** The whole selection — the dialog itself works out what it can touch. */
  ids: number[];
  /** How many of them carry no body yet, computed by the caller from rows it
   *  already has. The dialog never refetches the selection to say this. */
  withoutBody: number;
  /** How many carry a body that did NOT come from their own file (an
   *  attribution or an override) — what "Revert to the files" would touch. */
  revertible: number;
  onClose: () => void;
  onApplied: (message: string, ids: number[], change: DeviceChange) => void;
}) {
  const [bodies, setBodies] = useState<KnownBody[] | null>(null);
  const [chosen, setChosen] = useState<string>("");
  const [replace, setReplace] = useState(false);
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
  const withBody = ids.length - withoutBody;
  const targets = replace ? ids.length : withoutBody;

  async function post(payload: Record<string, unknown>) {
    return fetchJson<{ updated: number; skipped: number }>(
      "/api/pipeline/device-attribution",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
  }

  async function apply() {
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      const res = await post({
        ids,
        device: body.device,
        camera_model: body.camera_model ?? undefined,
        mode: replace ? "override" : "fill",
      });
      const name = friendlyCameraName(body.device);
      onApplied(
        res.updated
          ? replace
            ? `${res.updated.toLocaleString()} media set to ${name} — a correction that survives re-indexing`
            : `${res.updated.toLocaleString()} media assigned to ${name}`
          : replace
            ? `Nothing changed — the selection already carries ${name}`
            : "Nothing to assign — every selected medium already has a body",
        ids,
        replace ? { kind: "replace", body } : { kind: "fill", body },
      );
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  async function revert() {
    setBusy(true);
    setError(null);
    try {
      const res = await post({ ids, mode: "revert" });
      onApplied(
        res.updated
          ? `${res.updated.toLocaleString()} media back to what their files say`
          : "Nothing to revert — every selected body comes from its own file",
        ids,
        { kind: "revert" },
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

          <p>
            {withoutBody > 0 ? (
              <>
                <strong>{withoutBody.toLocaleString()}</strong> of the{" "}
                {ids.length.toLocaleString()} selected media carry no camera
                body
                {withBody > 0 && (
                  <>; {withBody.toLocaleString()} already have one</>
                )}
                .
              </>
            ) : (
              <>
                All {ids.length.toLocaleString()} selected media already carry
                a camera body.
              </>
            )}
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

          {withBody > 0 && (
            <label className={`dev-pick-replace${replace ? " is-on" : ""}`}>
              <input
                type="checkbox"
                checked={replace}
                onChange={(e) => setReplace(e.target.checked)}
              />
              <span>
                <strong>
                  Also replace the body on the {withBody.toLocaleString()} that
                  already have one
                </strong>
                <span className="dev-pick-note">
                  For a file that names the wrong camera. The correction
                  survives re-indexing; each file’s own value stays visible in
                  the viewer and “Revert to the files” restores it. Nothing is
                  written into the originals.
                </span>
              </span>
            </label>
          )}
          {withBody > 0 && !replace && (
            <p className="dev-pick-note">
              Left unticked, {withBody === 1 ? "it is" : "they are"} not
              touched.
            </p>
          )}
        </div>
        <div className="modal-actions">
          {revertible > 0 && (
            <button
              className="btn dev-pick-revert"
              onClick={() => void revert()}
              disabled={busy}
              title="Put the selected media back to the body their own files declare — or to none, where the file names none"
            >
              Revert {revertible.toLocaleString()} to the files
            </button>
          )}
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void apply()}
            disabled={busy || !body || targets === 0}
          >
            {busy ? (
              <Spinner sm />
            ) : replace ? (
              `Set ${targets.toLocaleString()}`
            ) : targets === 0 ? (
              // Not "Assign 0": say why the button is off.
              "Nothing to assign"
            ) : (
              `Assign ${targets.toLocaleString()}`
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
