"use client";

import { useEffect, useMemo, useState } from "react";
import { geotagAssets } from "@/lib/assetActions";
import type { PickedLocation } from "@/app/LocationPickerModal";

// Step 2 of the manual geotag flow: the per-media before/after recap. On a bulk
// apply this is the safety net against silently clobbering coordinates a camera
// actually recorded — every media is listed with its current position and the
// incoming one, and only the CHECKED rows are written. Media without a position
// start checked (that's the whole point of the action); media that already have
// one start UNCHECKED and must be opted in explicitly.

// What the recap needs to know about one media — a subset of AssetGridRow, so
// any host with grid rows can map straight into it.
export type GeotagRecapAsset = {
  id: number;
  filename: string;
  media_type: "photo" | "video";
  gps: { lat: number; lon: number } | null;
  gps_source?: "manual" | null;
  place_city?: string | null;
  place_country?: string | null;
};

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
  onClose,
  onApplied,
}: {
  assets: GeotagRecapAsset[];
  target: PickedLocation;
  onClose: () => void;
  /** Called once the update is applied, with ready-to-toast summary + the ids
   * actually written (for the host's optimistic state). */
  onApplied: (message: string, ids: number[]) => void;
}) {
  const withGps = useMemo(() => assets.filter((a) => a.gps), [assets]);
  const [checked, setChecked] = useState<Set<number>>(
    // Fill-the-holes by default; overwrites are an explicit opt-in per row.
    () => new Set(assets.filter((a) => !a.gps).map((a) => a.id)),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      const updated = await geotagAssets(ids, {
        lat: target.lat,
        lon: target.lon,
      });
      const bits = [`${updated} geotagged`];
      const overwritten = withGps.filter((a) => checked.has(a.id)).length;
      if (overwritten) bits.push(`${overwritten} position(s) overwritten`);
      onApplied(
        `${bits.join(" · ")}. Coordinates are being written into the originals.`,
        ids,
      );
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const count = checked.size;
  const skippedExisting = withGps.filter((a) => !checked.has(a.id)).length;

  return (
    <div
      className="modal-overlay"
      onClick={() => !busy && onClose()}
      role="presentation"
    >
      <div
        className="modal modal-wide"
        role="dialog"
        aria-modal="true"
        aria-label="Confirm geotag"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title">Confirm the new position</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          New position: <strong>{targetLabel}</strong>. Only the checked media
          are written — the coordinates go to the database and into the original
          file&rsquo;s metadata.
        </p>

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
              {assets.map((a) => {
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
                      {cur && a.gps_source === "manual" && (
                        <span className="hint"> (manual)</span>
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
