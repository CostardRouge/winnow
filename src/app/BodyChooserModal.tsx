"use client";

// "Assign to another camera…" — pick ONE body out of the ones the library
// already holds, with a search field.
//
// It exists because the Devices menus used to list every body inline: with
// twenty cameras the folder menu ran three screens tall on a phone and the
// answers that matter (name a camera, not a camera, review one by one) landed
// below the fold. The menu now carries the few actions; the long list of
// bodies lives here, behind one entry. On a phone it is a bottom sheet (the
// thumb reaches it, the search field is right there); on a desktop a modal.
//
// Still a pick, never free text: the value written has to be one the gear
// dimension already groups on (cf. DevicePickerModal, NameCameraModal for the
// one sanctioned typed name).
import { useEffect, useMemo, useRef, useState } from "react";
import { useOverlayDismiss } from "./useOverlayDismiss";
import { friendlyCameraName } from "@/lib/cameraLabels";
import type { KnownBody } from "@/lib/deviceTypes";

export default function BodyChooserModal({
  title,
  bodies,
  pinned,
  onPick,
  onClose,
}: {
  /** What is being assigned, as a phrase: "Assign the 11 media of Pot de départ". */
  title: string;
  /** Every body offered, busiest first. */
  bodies: KnownBody[];
  /** The raw device the folder already proposes, listed first with a tag. */
  pinned?: string | null;
  onPick: (body: KnownBody) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const backdrop = useOverlayDismiss<HTMLDivElement>(onClose);

  useEffect(() => {
    // Not on a touch device: the keyboard would cover the very list to pick from.
    if (window.matchMedia("(pointer: fine)").matches) input.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = needle
      ? bodies.filter(
          (b) =>
            friendlyCameraName(b.device).toLowerCase().includes(needle) ||
            b.device.toLowerCase().includes(needle),
        )
      : bodies;
    // The proposal first, the rest keep the busiest-first order they came in.
    return [...list].sort(
      (a, b) => Number(b.device === pinned) - Number(a.device === pinned),
    );
  }, [bodies, q, pinned]);

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
          <button
            type="button"
            className="btn btn-sm"
            onClick={onClose}
            aria-label="Close"
          >
            Cancel
          </button>
        </div>
        <input
          ref={input}
          className="input"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`Search ${bodies.length} cameras`}
          aria-label="Search cameras"
          autoComplete="off"
        />
        <div className="body-chooser-list" role="listbox" aria-label="Camera body">
          {shown.length === 0 ? (
            <p className="hint body-chooser-empty">
              No camera matches “{q.trim()}”.
            </p>
          ) : (
            shown.map((b) => (
              <button
                key={b.device}
                type="button"
                role="option"
                aria-selected={false}
                className="body-chooser-row"
                onClick={() => onPick(b)}
              >
                <span className="body-chooser-text">
                  <span className="body-chooser-name">
                    {friendlyCameraName(b.device)}
                    {b.device === pinned && (
                      <span className="pill body-chooser-tag">proposed</span>
                    )}
                  </span>
                  <span className="body-chooser-raw">
                    {b.named ? "named by hand" : b.device}
                  </span>
                </span>
                <span className="body-chooser-count">
                  {b.count.toLocaleString()}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
