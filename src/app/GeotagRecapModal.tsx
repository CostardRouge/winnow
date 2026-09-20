"use client";

import { useEffect, useMemo, useState } from "react";
import { geotagAssets, type GeotagSource } from "@/lib/assetActions";
import type { PickedLocation } from "@/app/LocationPickerModal";
import { useOverlayDismiss } from "@/app/useOverlayDismiss";

// Step 2 of the manual geotag flow: the per-media before/after recap. On a bulk
// apply this is the safety net against silently clobbering coordinates a camera
// actually recorded — every media is listed with its current position and the
// incoming one, and only the CHECKED rows are written. Media without a position
// start checked (that's the whole point of the action); media that already have
// one start UNCHECKED and must be opted in explicitly.
//
// Two things the Unplaced view (docs/UNPLACED.md) added:
//
//   - `source`: what kind of human act this apply is. 'manual' (a pin placed
//     knowing the place) writes into the originals' EXIF; 'inferred' (a
//     folder-scale suggestion accepted in bulk) is recorded on the rows only
//     and never enters a file (§4.3). The recap says which, in words, before
//     the button — the difference is invisible otherwise and it is the one
//     that matters to anyone reading gps_source later.
//   - the list folds past FULL_LIST_MAX media: a folder of several thousand
//     RAWs would render thousands of thumbnail rows to say "none of these has
//     a position". Above the threshold the media WITHOUT a position are
//     summarised in one line (they all start checked, as always) and the
//     table keeps only the rows this dialog exists to protect — the ones that
//     already carry a position and would be overwritten. Check all / Uncheck
//     all still act on every media, listed or not.

// What the recap needs to know about one media — a subset of AssetGridRow, so
// any host with grid rows can map straight into it.
export type GeotagRecapAsset = {
  id: number;
  filename: string;
  media_type: "photo" | "video";
  gps: { lat: number; lon: number } | null;
  gps_source?: GeotagSource | null;
  place_city?: string | null;
  place_country?: string | null;
};

// Past this many media the position-less rows are summarised rather than
// listed (see the header). 200 keeps a whole ordinary session readable and
// folds the folder-sized applies.
const FULL_LIST_MAX = 200;

const fmtCoord = (gps: { lat: number; lon: number }) =>
  `${gps.lat.toFixed(5)}, ${gps.lon.toFixed(5)}`;

// "Paris, France · 48.85341, 2.34880" when the place is resolved, bare
// coordinates otherwise.
function before(a: GeotagRecapAsset): string | null {
  if (!a.gps) return null;
  const place = [a.place_city, a.place_country].filter(Boolean).join(", ");
  return place ? `${place} · ${fmtCoord(a.gps)}` : fmtCoord(a.gps);
}

export default function GeotagRecapModal({
  assets,
  target,
  source = "manual",
  sourceNote,
  onClose,
  onApplied,
}: {
  assets: GeotagRecapAsset[];
  target: PickedLocation;
  /** How this position was arrived at — decides whether the originals are
   * written (`manual`) or only the rows (`inferred`). Defaults to manual, which
   * is what every pre-existing entry point (a pin placed by hand) is. */
  source?: GeotagSource;
  /** One sentence from the host on where an inferred suggestion came from, so
   * the person confirming it can judge it ("From 412 iPhone frames shot in the
   * same hours, 96 % in one cell"). Shown under the position when set. */
  sourceNote?: string | null;
  onClose: () => void;
  /** Called once the update is applied, with ready-to-toast summary + the ids
   * actually written (for the host's optimistic state) + the source recorded. */
  onApplied: (message: string, ids: number[], source: GeotagSource) => void;
}) {
  const withGps = useMemo(() => assets.filter((a) => a.gps), [assets]);
  const withoutGps = useMemo(() => assets.filter((a) => !a.gps), [assets]);
  const folded = assets.length > FULL_LIST_MAX;
  // The rows drawn in the table: everything, or — folded — only the ones with
  // something to lose.
  const listed = folded ? withGps : assets;

  const [checked, setChecked] = useState<Set<number>>(
    // Fill-the-holes by default; overwrites are an explicit opt-in per row.
    () => new Set(withoutGps.map((a) => a.id)),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Same guard as the picker: only a press that started on the backdrop
  // dismisses, so a drag released outside the dialog does not lose the recap.
  const backdrop = useOverlayDismiss<HTMLDivElement>(() => {
    if (!busy) onClose();
  });

  const targetLabel = target.label
    ? `${target.label} · ${fmtCoord(target)}`
    : fmtCoord(target);

  const toggle = (id: number) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const setAll = (ids: number[], on: boolean) =>
    setChecked((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  // Close on Escape (unless a request is in flight).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  async function submit() {
    const ids = assets.filter((a) => checked.has(a.id)).map((a) => a.id);
    if (!ids.length) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await geotagAssets(
        ids,
        { lat: target.lat, lon: target.lon },
        source,
      );
      const bits = [`${updated} geotagged`];
      const overwritten = withGps.filter((a) => checked.has(a.id)).length;
      if (overwritten) bits.push(`${overwritten} position(s) overwritten`);
      const tail =
        source === "inferred"
          ? "Recorded as a suggested position — not written into the originals."
          : "Coordinates are being written into the originals.";
      onApplied(`${bits.join(" · ")}. ${tail}`, ids, source);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const count = checked.size;
  const skippedExisting = withGps.filter((a) => !checked.has(a.id)).length;
  // How many of the summarised (unlisted) position-less media are checked —
  // the number the fold line has to state, since those rows are not on screen.
  const foldedChecked = folded
    ? withoutGps.filter((a) => checked.has(a.id)).length
    : 0;

  return (
    <div className="modal-overlay" role="presentation" {...backdrop}>
      <div
        className="modal modal-wide"
        role="dialog"
        aria-modal="true"
        aria-label="Confirm geotag"
      >
        <h2 className="modal-title">Confirm the new position</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          New position: <strong>{targetLabel}</strong>. Only the checked media
          are written —{" "}
          {source === "inferred" ? (
            <>
              recorded as a <strong>suggested position</strong> in the
              database, and <strong>not</strong> written into the original
              files. Place a pin by hand to record a verified position.
            </>
          ) : (
            <>
              the coordinates go to the database and into the original
              file&rsquo;s metadata.
            </>
          )}
        </p>
        {sourceNote && (
          <p className="hint" style={{ marginTop: -4 }}>
            {sourceNote}
          </p>
        )}

        {withGps.length > 0 && (
          <p className="modal-warn">
            {withGps.length} media already carry a position. They are unchecked
            by default — tick a row to overwrite it.
          </p>
        )}

        <div className="recap-toolbar">
          <button
            className="btn"
            disabled={busy}
            onClick={() => setAll(assets.map((a) => a.id), true)}
          >
            Check all
          </button>
          <button
            className="btn"
            disabled={busy}
            onClick={() => setAll(assets.map((a) => a.id), false)}
          >
            Uncheck all
          </button>
          <span className="hint">
            {count}/{assets.length} to write
          </span>
        </div>

        {folded && (
          <p className="hint" style={{ marginTop: 8 }}>
            {withoutGps.length} media have no position yet and are not listed
            one by one — {foldedChecked} of them{" "}
            {foldedChecked === withoutGps.length ? "(all) " : ""}
            will be written.
            {withGps.length > 0
              ? " The rows below are the ones that already carry a position."
              : ""}
          </p>
        )}

        {listed.length > 0 && (
          <div className="recap-table-wrap">
            <table className="recap-table">
              <thead>
                <tr>
                  <th aria-label="Apply" />
                  <th aria-label="Preview" />
                  <th>Media</th>
                  <th>Before</th>
                  <th>After</th>
                </tr>
              </thead>
              <tbody>
                {listed.map((a) => {
                  const cur = before(a);
                  const on = checked.has(a.id);
                  return (
                    <tr
                      key={a.id}
                      className={on ? undefined : "is-skipped"}
                      onClick={() => !busy && toggle(a.id)}
                    >
                      <td>
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={busy}
                          onChange={() => toggle(a.id)}
                          onClick={(e) => e.stopPropagation()}
                          aria-label={`Geotag ${a.filename}`}
                        />
                      </td>
                      <td>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          className="recap-thumb"
                          src={`/api/assets/${a.id}/thumb`}
                          alt=""
                          loading="lazy"
                        />
                      </td>
                      <td className="recap-name" title={a.filename}>
                        {a.filename}
                      </td>
                      <td className={cur ? "recap-before" : "recap-none"}>
                        {cur ?? "— none —"}
                        {cur && a.gps_source && (
                          <span className="hint"> ({a.gps_source})</span>
                        )}
                      </td>
                      <td className="recap-after">
                        {on ? fmtCoord(target) : "unchanged"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {skippedExisting > 0 && (
          <p className="hint" style={{ marginTop: 8 }}>
            {skippedExisting} media keep their current position.
          </p>
        )}
        {error && <p className="modal-warn">{error}</p>}

        <div className="modal-actions">
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={submit}
            disabled={busy || count === 0}
          >
            {busy ? "Applying…" : `Apply to ${count} media`}
          </button>
        </div>
      </div>
    </div>
  );
}
