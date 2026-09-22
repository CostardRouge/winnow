"use client";

import { useEffect, useState } from "react";
import LocationPicker, { type PickedLocation } from "@/app/LocationPicker";
import { useOverlayDismiss } from "@/app/useOverlayDismiss";

// Step 1 of the manual geotag flow (cf. GeotagRecapModal for step 2): choose
// the capture location, then "Continue" hands the point to the caller, which
// opens the recap.
//
// The control itself — search, map, coordinates — is `LocationPicker`, shared
// with the recap, which embeds the same thing so a pre-filled position can be
// judged and adjusted without a second dialog (docs/UNPLACED.md §9.7). This
// file is the dialog around it: the shell, the title, the two buttons.

export type { PickedLocation };

export default function LocationPickerModal({
  count,
  initial,
  onClose,
  onPicked,
}: {
  /** How many assets are being geotagged (title only). */
  count: number;
  /** Seed position (e.g. the asset's current GPS when re-tagging). */
  initial?: { lat: number; lon: number } | null;
  onClose: () => void;
  /** Called with the confirmed point; the caller opens the recap modal. */
  onPicked: (loc: PickedLocation) => void;
}) {
  // Dismiss on the backdrop only for a press that also *started* there:
  // panning the map often releases the mouse outside the modal, and a plain
  // onClick on the overlay would take that as a click on the backdrop.
  const backdrop = useOverlayDismiss<HTMLDivElement>(onClose);

  const [pos, setPos] = useState<PickedLocation | null>(
    initial ? { ...initial, label: null } : null,
  );

  // Close on Escape. The picker stops the event itself while its suggestion
  // list is open, so the dropdown closes first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" role="presentation" {...backdrop}>
      <div
        className="modal modal-wide"
        role="dialog"
        aria-modal="true"
        aria-label="Choose a location"
      >
        <h2 className="modal-title">
          Geotag {count} {count === 1 ? "media" : "medias"}
        </h2>
        <p className="hint" style={{ marginTop: 0 }}>
          Search a place, click the map or drag the marker to the capture
          location.
        </p>

        <LocationPicker
          value={pos}
          onChange={setPos}
          autoFocus
          inputId="geotag-place"
        />

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!pos}
            onClick={() => pos && onPicked(pos)}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
