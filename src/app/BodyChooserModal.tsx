"use client";

// "Assign to another camera…" — pick ONE body out of the ones the library
// already holds, then confirm.
//
// It exists because the Devices menus used to list every body inline: with
// twenty cameras the folder menu ran three screens tall on a phone and the
// answers that matter (name a camera, not a camera, review one by one) landed
// below the fold. The menu now carries the few actions; the list of bodies
// lives here. Shape chosen by the maintainer from five mockups (variant A):
// quick picks on top, the whole list below in one scrolling zone (a library
// holds a few dozen bodies at most — no search field), and a pinned footer
// with the confirm button and the other answers, never under the scroll. A
// tap outside the sheet dismisses it. On a phone it is a bottom sheet.
//
// Still a pick, never free text: the value written has to be one the gear
// dimension already groups on (cf. DevicePickerModal, NameCameraModal for the
// one sanctioned typed name).
import { useEffect, useMemo, useState } from "react";
import { useOverlayDismiss } from "./useOverlayDismiss";
import { friendlyCameraName } from "@/lib/cameraLabels";
import type { KnownBody } from "@/lib/deviceTypes";

export type ChooserAction = { key: string; label: string; onSelect: () => void };

// The last body assigned from this sheet, per browser: the third quick pick.
const LAST_KEY = "winnow.devices.lastAssigned";

function readLast(): string | null {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}

export default function BodyChooserModal({
  title,
  confirmPrefix = "Assign",
  bodies,
  pinned,
  actions = [],
  onPick,
  onClose,
}: {
  /** What is being assigned, as a phrase: "Assign the 11 media of Pot de départ". */
  title: string;
  /** The confirm button reads `${confirmPrefix} to ${camera}` ("Assign 11"). */
  confirmPrefix?: string;
  /** Every body offered, busiest first. */
  bodies: KnownBody[];
  /** The raw device the folder already proposes, listed first with a tag. */
  pinned?: string | null;
  /** The other answers (name a camera, not a camera…), pinned under the list. */
  actions?: ChooserAction[];
  onPick: (body: KnownBody) => void;
  onClose: () => void;
}) {
  const [sel, setSel] = useState<string | null>(null);
  const [last, setLast] = useState<string | null>(null);
  const backdrop = useOverlayDismiss<HTMLDivElement>(onClose);

  useEffect(() => {
    setLast(readLast());
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Busiest first; the proposal stays in its place in the list and is also
  // the first quick pick, so nothing here is reordered under the thumb.
  const sorted = useMemo(
    () => [...bodies].sort((a, b) => b.count - a.count),
    [bodies],
  );
  const quick = useMemo(() => {
    const out: { body: KnownBody; tag: string }[] = [];
    const add = (b: KnownBody | undefined, tag: string) => {
      if (b && !out.some((o) => o.body.device === b.device)) out.push({ body: b, tag });
    };
    add(sorted.find((b) => b.device === pinned), "Proposed");
    add(sorted.find((b) => !out.some((o) => o.body.device === b.device)), "Most used");
    add(sorted.find((b) => b.device === last), "Last assigned");
    // A fresh browser has no "last": the next busiest fills the slot.
    while (out.length < 3) {
      const next = sorted.find((b) => !out.some((o) => o.body.device === b.device));
      if (!next) break;
      add(next, "Frequent");
    }
    return out;
  }, [sorted, pinned, last]);

  const chosen = sorted.find((b) => b.device === sel);

  const confirm = () => {
    if (!chosen) return;
    try {
      localStorage.setItem(LAST_KEY, chosen.device);
    } catch {
      /* private mode: the quick pick just stays on "Frequent" */
    }
    onPick(chosen);
  };

  return (
    <div className="modal-backdrop body-chooser-backdrop" {...backdrop}>
      <div
        className="modal body-chooser"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="body-chooser-head">
          <h3 className="modal-title">{title}</h3>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            Cancel
          </button>
        </div>

        <div className="body-chooser-label">Quick picks</div>
        <div className="body-chooser-quick">
          {quick.map(({ body, tag }) => (
            <button
              key={body.device}
              type="button"
              className={`body-chooser-tile${sel === body.device ? " is-on" : ""}`}
              aria-pressed={sel === body.device}
              onClick={() => setSel(body.device)}
            >
              <span className="body-chooser-tag">{tag}</span>
              <span className="body-chooser-tilename">
                {friendlyCameraName(body.device)}
              </span>
            </button>
          ))}
        </div>

        <div className="body-chooser-list" role="listbox" aria-label="Camera body">
          {sorted.map((b) => (
            <button
              key={b.device}
              type="button"
              role="option"
              aria-selected={sel === b.device}
              className={`body-chooser-row${sel === b.device ? " is-on" : ""}`}
              onClick={() => setSel(b.device)}
            >
              <span className="body-chooser-text">
                <span className="body-chooser-name">
                  {friendlyCameraName(b.device)}
                </span>
                <span className="body-chooser-raw">
                  {b.named ? "named by hand" : b.device}
                </span>
              </span>
              <span className="body-chooser-count">
                {b.count.toLocaleString()}
              </span>
            </button>
          ))}
        </div>

        <div className="body-chooser-foot">
          <button
            type="button"
            className="btn btn-primary body-chooser-confirm"
            disabled={!chosen}
            onClick={confirm}
          >
            {chosen
              ? `${confirmPrefix} to ${friendlyCameraName(chosen.device)}`
              : "Pick a camera above"}
          </button>
          {actions.length > 0 && (
            <div className="body-chooser-actions">
              {actions.map((a) => (
                <button
                  key={a.key}
                  type="button"
                  className="btn"
                  onClick={a.onSelect}
                >
                  {a.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
