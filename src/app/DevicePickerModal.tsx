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
//   • NAME / NOT A CAMERA — the two hand answers of migration 0051, below the
//     list: a camera no file names, typed ('named'), or none at all ('none').
//     Only on media whose body did not come off their file — a hole, or an
//     earlier attribution, which is how a screenshot once "assigned to the
//     iPhone" gets set aside — never on a body a file declares.
// Replacing is never the default and never implied by leaving a box unticked:
// the one write that can overwrite a camera's own value has to be asked for.
import { useEffect, useState } from "react";
import { Spinner } from "./ui";
import { friendlyCameraName } from "@/lib/cameraLabels";
import { fetchJson } from "@/lib/fetchJson";
import type { ApplyResult, KnownBody } from "@/lib/deviceTypes";
import type { DeviceChange } from "@/lib/deviceChange";

// The row rules (what each outcome does to a grid row) live in lib/deviceChange
// so both grids share them and a test covers them; re-exported for the hosts.
export {
  applyDeviceChange,
  deviceSelectionCounts,
  type DeviceChange,
} from "@/lib/deviceChange";

// The route's ceiling on one call (its zod schema). A grid selection is not
// bounded by it — "Select all" takes every row loaded so far — so the write is
// sent in slices of this size and the counts summed: a cap the selection could
// outgrow, met by a 400 on the whole lot, is the silent limit
// docs/SILENT-LIMITS-AUDIT.md exists to remove.
const CHUNK = 5000;

// The two choices below the bodies, as values of the same radio group. No
// EXIF string starts with a NUL, so they cannot collide with a body.
const NAME = "\u0000name";
const NONE = "\u0000none";

export default function DevicePickerModal({
  ids,
  withoutBody,
  revertible,
  relabelable,
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
  /** How many carry no body or one that did not come off their file — what a
   *  name or "not a camera" would touch. */
  relabelable: number;
  onClose: () => void;
  onApplied: (message: string, ids: number[], change: DeviceChange) => void;
}) {
  const [bodies, setBodies] = useState<KnownBody[] | null>(null);
  const [chosen, setChosen] = useState<string>("");
  const [nameText, setNameText] = useState("");
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
  const hand = chosen === NAME || chosen === NONE;
  const typed = nameText.trim().replace(/\s+/g, " ");
  const targets = hand ? relabelable : replace ? ids.length : withoutBody;

  // One write, sliced. Returns what landed; a slice that fails stops the run
  // and is reported with the slices that DID land, so the grid reflects
  // exactly those and the message says the rest was not touched.
  async function post(
    payload: Record<string, unknown>,
  ): Promise<{ updated: number; done: number[]; failure: string | null }> {
    let updated = 0;
    const done: number[] = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      try {
        const r = await fetchJson<ApplyResult>(
          "/api/pipeline/device-attribution",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...payload, ids: slice }),
          },
        );
        updated += r.updated;
        done.push(...slice);
      } catch (e) {
        return { updated, done, failure: (e as Error).message };
      }
    }
    return { updated, done, failure: null };
  }

  // The outcome of a run: nothing landed → the error stays in the dialog;
  // something landed → the grid is told, with the failure appended.
  function settle(
    res: { updated: number; done: number[]; failure: string | null },
    message: string,
    change: DeviceChange,
  ) {
    if (res.failure && !res.done.length) {
      setError(res.failure);
      setBusy(false);
      return;
    }
    onApplied(
      res.failure
        ? `${message} — then a request failed (${res.failure}); the other ${(ids.length - res.done.length).toLocaleString()} selected media were not touched`
        : message,
      res.done,
      change,
    );
  }

  async function apply() {
    if (hand) return label();
    if (!body) return;
    setBusy(true);
    setError(null);
    const res = await post({
      device: body.device,
      camera_model: body.camera_model ?? undefined,
      mode: replace ? "override" : "fill",
    });
    const name = friendlyCameraName(body.device);
    settle(
      res,
      res.updated
        ? replace
          ? `${res.updated.toLocaleString()} media set to ${name} — a correction that survives re-indexing`
          : `${res.updated.toLocaleString()} media assigned to ${name}`
        : replace
          ? `Nothing changed — the selection already carries ${name}`
          : "Nothing to assign — every selected medium already has a body",
      replace ? { kind: "replace", body } : { kind: "fill", body },
    );
  }

  // A name or "not a camera". A name already given is reused with its first
  // spelling, as the server does, so the grid shows what was written.
  async function label() {
    if (chosen === NAME && !typed) return;
    setBusy(true);
    setError(null);
    const name =
      chosen === NAME
        ? (bodies?.find((b) => b.named && b.device.toLowerCase() === typed.toLowerCase())
            ?.device ?? typed)
        : null;
    const res = await post(name ? { mode: "name", device: name } : { mode: "none" });
    settle(
      res,
      res.updated
        ? name
          ? `${res.updated.toLocaleString()} media named “${name}”`
          : `${res.updated.toLocaleString()} media marked as not a camera`
        : "Nothing changed — every selected body comes from its own file",
      name ? { kind: "name", device: name } : { kind: "none" },
    );
  }

  async function revert() {
    setBusy(true);
    setError(null);
    const res = await post({ mode: "revert" });
    settle(
      res,
      res.updated
        ? `${res.updated.toLocaleString()} media back to what their files say`
        : "Nothing to revert — every selected body comes from its own file",
      { kind: "revert" },
    );
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
          {error && (
            <p className="dev-pick-warn" role="alert">
              {error}
            </p>
          )}

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
                  <span className="dev-pick-raw">
                    {b.named ? "named by hand" : b.device}
                  </span>
                  <span className="dev-pick-count">
                    {b.count.toLocaleString()}
                  </span>
                </label>
              ))}
            </div>
          )}

          {/* Not one of these: the camera has no file here, or there is no
              camera at all. Same radio group, so one choice is ever live. */}
          <div className="dev-pick-list dev-pick-hand" role="radiogroup" aria-label="Not one of these">
            <label className={`dev-pick-row${chosen === NAME ? " is-on" : ""}`}>
              <input
                type="radio"
                name="device-body"
                checked={chosen === NAME}
                onChange={() => setChosen(NAME)}
              />
              <span className="dev-pick-name">Name another camera</span>
              <span className="dev-pick-raw">no file names it</span>
            </label>
            {chosen === NAME && (
              <div className="dev-pick-row dev-pick-typed">
                <input
                  className="input"
                  value={nameText}
                  onChange={(e) => setNameText(e.target.value)}
                  placeholder="Emeric’s camera"
                  maxLength={200}
                  aria-label="Camera name"
                  list="dev-named-bodies"
                  autoFocus
                />
                <datalist id="dev-named-bodies">
                  {bodies?.filter((b) => b.named).map((b) => (
                    <option key={b.device} value={b.device} />
                  ))}
                </datalist>
              </div>
            )}
            <label className={`dev-pick-row${chosen === NONE ? " is-on" : ""}`}>
              <input
                type="radio"
                name="device-body"
                checked={chosen === NONE}
                onChange={() => setChosen(NONE)}
              />
              <span className="dev-pick-name">Not a camera</span>
              <span className="dev-pick-raw">screenshot, saved image</span>
            </label>
          </div>
          {hand && (
            <p className="dev-pick-note">
              {relabelable === ids.length
                ? "Every selected medium is touched."
                : `${relabelable.toLocaleString()} of the selection — a body their own file declares is left alone (correct it with a body above instead).`}
            </p>
          )}

          {!hand && withBody > 0 && (
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
          {!hand && withBody > 0 && !replace && (
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
            disabled={
              busy ||
              targets === 0 ||
              (hand ? chosen === NAME && !typed : !body)
            }
          >
            {busy ? (
              <Spinner sm />
            ) : hand ? (
              targets === 0 ? (
                "Nothing to change"
              ) : chosen === NAME ? (
                `Name ${targets.toLocaleString()}`
              ) : (
                `Set ${targets.toLocaleString()} aside`
              )
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
