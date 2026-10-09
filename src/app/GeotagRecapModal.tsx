"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { geotagAssets, type GeotagSource } from "@/lib/assetActions";
import type { PickedLocation } from "@/app/LocationPicker";
import { useOverlayDismiss } from "@/app/useOverlayDismiss";
import MediaViewer from "@/app/MediaViewer";

// Step 2 of the manual geotag flow: the per-media before/after recap. On a bulk
// apply this is the safety net against silently clobbering coordinates a camera
// actually recorded — every media is listed with its current position and the
// incoming one, and only the CHECKED rows are written. Media without a position
// start checked (that's the whole point of the action); media that already have
// one start UNCHECKED and must be opted in explicitly.
//
// Three things the Unplaced view (docs/UNPLACED.md) added:
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
//   - `onTargetChange`: with it the position is EDITABLE here, through the same
//     `LocationPicker` the location dialog is built on — map, place search and
//     coordinate fields. A screen that arrives with a pre-filled point (the
//     Unplaced view's suggestion) then needs no map step before this one: the
//     map is the feedback, since "43.56000, 3.90000" tells nobody where that
//     is, and moving the pin here is how a suggestion gets corrected (§9.7).
//     Without it the position is fixed and stated in words — the flows that
//     came through the picker already chose it.
//   - `folders`: a multi-folder apply is listed folder by folder, one row and
//     one checkbox each, ABOVE the per-media table. The card's own folder
//     starts ticked; the folders shot alongside it start unticked and have to
//     be opted in, the same rule as an overwrite. Past FULL_LIST_MAX the
//     per-media table folds away, and without these rows a 1 732-media write
//     read as one number with no folder in it — the maintainer could not tell
//     that 1 360 of those media lived in a folder he had not opened (§9.8).
//
// Its shape, for every host: a column of title, a body that scrolls, and the
// actions pinned under it — Apply is never below the fold, however long the
// folder list or the warning. With the map, a wide screen gets a 1200 px sheet
// whose left half is the map at full height and whose right half holds the
// fields, the record and the media list; the list takes the height left and
// scrolls in place, so a bigger map costs the buttons nothing. A thumbnail
// opens the shared MediaViewer STACKED over the dialog (it portals to <body>),
// on the listed rows, with the row's checkbox in its bar: closing it — Escape
// included, which this dialog ignores while the viewer is up — lands back on
// the recap as it was, ticks and scroll intact.

// Leaflet touches `window` on import, and this dialog is imported statically
// by its hosts: the map control has to come in client-side only.
const LocationPicker = dynamic(() => import("@/app/LocationPicker"), {
  ssr: false,
});

// What the recap needs to know about one media — a subset of AssetGridRow, so
// any host with grid rows can map straight into it.
export type GeotagRecapAsset = {
  id: number;
  /** Required for the per-folder rows to find a media's folder. */
  session_id?: number;
  filename: string;
  media_type: "photo" | "video";
  gps: { lat: number; lon: number } | null;
  gps_source?: GeotagSource | null;
  place_city?: string | null;
  place_country?: string | null;
};

// One folder of a multi-folder apply: what its row says, and whether it starts
// ticked (the card's own folder) or not (a folder shot alongside).
export type RecapFolder = {
  id: number;
  name: string;
  /** One line under the name: the body and the capture window. */
  detail: string;
  primary: boolean;
};

// A checkbox with the third state the DOM has and React does not expose as a
// prop: a folder whose media are only partly ticked is neither on nor off.
function TriCheck({
  state,
  onChange,
  disabled,
  label,
}: {
  state: "on" | "off" | "some";
  onChange: () => void;
  disabled: boolean;
  label: string;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "some";
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={state === "on"}
      disabled={disabled}
      onChange={onChange}
      aria-label={label}
    />
  );
}

// Past this many media the position-less rows are summarised rather than
// listed (see the header). 200 keeps a whole ordinary session readable and
// folds the folder-sized applies.
const FULL_LIST_MAX = 200;

const fmtCoord = (gps: { lat: number; lon: number }) =>
  `${gps.lat.toFixed(5)}, ${gps.lon.toFixed(5)}`;

// "Paris, France" + "48.85341, 2.34880" when the place is resolved, bare
// coordinates otherwise — two parts so a narrow column breaks between them
// rather than through the coordinate.
function before(a: GeotagRecapAsset): { place: string; coord: string } | null {
  if (!a.gps) return null;
  const place = [a.place_city, a.place_country].filter(Boolean).join(", ");
  return { place, coord: fmtCoord(a.gps) };
}

export default function GeotagRecapModal({
  assets,
  target,
  source = "manual",
  sourceNote,
  onTargetChange,
  folders,
  onClose,
  onApplied,
}: {
  assets: GeotagRecapAsset[];
  /** The position to write. Null is only possible when `onTargetChange` is
   *  set — the dialog then opens on an empty map and Apply waits for a pin. */
  target: PickedLocation | null;
  /** How this position was arrived at — decides whether the originals are
   * written (`manual`) or only the rows (`inferred`). Defaults to manual, which
   * is what every pre-existing entry point (a pin placed by hand) is. */
  source?: GeotagSource;
  /** One sentence from the host on where an inferred suggestion came from, so
   * the person confirming it can judge it ("From 412 iPhone frames shot in the
   * same hours, 96 % in one cell"). Shown under the position when set. */
  sourceNote?: string | null;
  /** Set it to make the position editable in place (map + search + fields).
   *  The host owns the point, so it can re-decide `source` from how far the
   *  pin moved — which is exactly what the Unplaced view does. */
  onTargetChange?: (loc: PickedLocation) => void;
  /** The folders this apply spans, when more than one is on offer — each gets
   *  a row and a checkbox. Media are matched to their folder by session_id. */
  folders?: RecapFolder[];
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

  // Folder rows only when there is a choice to make between folders.
  const folderRows = folders && folders.length > 1 ? folders : null;

  const [checked, setChecked] = useState<Set<number>>(() => {
    // Fill-the-holes by default; overwrites are an explicit opt-in per row,
    // and so is every folder that is not the card's own.
    const primary = new Set(
      (folderRows ?? []).filter((f) => f.primary).map((f) => f.id),
    );
    return new Set(
      withoutGps
        .filter(
          (a) => !folderRows || a.session_id == null || primary.has(a.session_id),
        )
        .map((a) => a.id),
    );
  });

  // Each folder's media, and among them the ones with no position — what a
  // folder checkbox ticks.
  const byFolder = useMemo(() => {
    const m = new Map<number, { all: number[]; holes: number[] }>();
    for (const a of assets) {
      if (a.session_id == null) continue;
      let e = m.get(a.session_id);
      if (!e) m.set(a.session_id, (e = { all: [], holes: [] }));
      e.all.push(a.id);
      if (!a.gps) e.holes.push(a.id);
    }
    return m;
  }, [assets]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The listed row open in the viewer stacked over this dialog, if any.
  const [viewing, setViewing] = useState<number | null>(null);

  // Same guard as the picker: only a press that started on the backdrop
  // dismisses, so a drag released outside the dialog does not lose the recap.
  const backdrop = useOverlayDismiss<HTMLDivElement>(() => {
    if (!busy) onClose();
  });

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

  // A folder is on when every media it has with no position is ticked, off
  // when none of its media is, and partly on otherwise (an overwrite ticked by
  // hand, or a row unticked in the table).
  const folderState = (id: number): "on" | "off" | "some" => {
    const e = byFolder.get(id);
    if (!e) return "off";
    const n = e.all.filter((x) => checked.has(x)).length;
    if (n === 0) return "off";
    const holesFilled =
      e.holes.length > 0 && e.holes.every((x) => checked.has(x));
    return holesFilled && n === e.holes.length ? "on" : "some";
  };
  // Ticking a folder fills its holes (its placed media stay an explicit
  // per-row opt-in); unticking it releases every media of it.
  const toggleFolder = (id: number) => {
    const e = byFolder.get(id);
    if (!e) return;
    if (folderState(id) === "off") setAll(e.holes, true);
    else setAll(e.all, false);
  };

  // Close on Escape (unless a request is in flight). The picker swallows the
  // key itself while its suggestion list is open. While the viewer is stacked
  // on top, Escape is ITS key: both listen on window, and this handler still
  // sees `viewing` set in the event that closes the viewer, so one press
  // closes one layer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy && viewing == null) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose, viewing]);

  async function submit() {
    if (!target) return;
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

  // What the position is and what writing it means, in three short lines
  // instead of one paragraph: the place, the kind of record, and — when the
  // host offered one — where the suggestion came from.
  const record = (
    <div className="recap-record">
      <p className="recap-place">
        {target ? (
          <>
            {target.label && <strong>{target.label}</strong>}
            <span className="recap-coord">{fmtCoord(target)}</span>
          </>
        ) : (
          <span className="hint">No position chosen yet.</span>
        )}
      </p>
      <p className="recap-kind">
        {/* The pill the cards wear, here saying what KIND of record this is
            rather than how sure it is: a verified position reads as ink
            because it is the one that reaches the original files. */}
        <span className={source === "inferred" ? "conf" : "conf is-high"}>
          {source === "inferred" ? "suggested" : "verified"}
        </span>
        {source === "inferred" ? (
          <>
            Recorded in Winnow only — never written into the original files.
            {onTargetChange
              ? " Move the pin to record a verified position instead."
              : ""}
          </>
        ) : (
          <>Written to the database and into each original file&rsquo;s metadata.</>
        )}
      </p>
      {sourceNote && <p className="hint">{sourceNote}</p>}
    </div>
  );

  // Everything under the position: the folders, the overwrite warning and the
  // per-media table. Beside the map's fields on a wide screen, under them
  // otherwise — the picker's grid decides (see LocationPicker's `aside`).
  const recap = (
    <>
      {record}

      {folderRows && (
        <div className="recap-folders" role="group" aria-label="Folders">
          <p className="recap-folders-head">
            {folderRows.length} folders — the card&rsquo;s own, and the ones
            shot within a couple of hours of it. Tick the ones this position is
            for.
          </p>
          {folderRows.map((f) => {
            const e = byFolder.get(f.id);
            const holes = e?.holes.length ?? 0;
            const files = e?.all.length ?? 0;
            const writing = e ? e.all.filter((x) => checked.has(x)).length : 0;
            const st = folderState(f.id);
            return (
              <label
                key={f.id}
                className={`recap-folder${st === "off" ? " is-off" : ""}`}
              >
                <TriCheck
                  state={st}
                  onChange={() => toggleFolder(f.id)}
                  disabled={busy || files === 0}
                  label={`Place ${f.name}`}
                />
                <span className="recap-folder-text">
                  <span className="recap-folder-name" title={f.name}>
                    {f.name}
                  </span>
                  {/* The marker leads the detail line rather than trailing
                      the name: a long folder path truncates, and it would
                      take "this card" with it. */}
                  <span className="recap-folder-detail">
                    {f.primary ? `This card · ${f.detail}` : f.detail}
                  </span>
                </span>
                <span className="recap-folder-count">
                  <strong>{writing.toLocaleString("en-GB")}</strong> to write
                  <span className="hint">
                    {" "}
                    of {files.toLocaleString("en-GB")} ·{" "}
                    {holes.toLocaleString("en-GB")} unplaced
                  </span>
                </span>
              </label>
            );
          })}
        </div>
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
        <p className="hint recap-fold">
          {withoutGps.length} media have no position yet and are not listed one
          by one — {foldedChecked} of them{" "}
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
                {/* Before and after share a column: every ticked row would
                    print the same target under a separate "After", and the
                    width it took is what the thumbnail needs beside the map. */}
                <th>Position</th>
              </tr>
            </thead>
            <tbody>
              {listed.map((a, i) => {
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
                    <td className="recap-thumb-cell">
                      {/* The thumbnail at the file's own ratio (the derivative
                          is fit "inside"), and a way to look at it properly:
                          the row toggles, the picture opens the viewer. */}
                      <button
                        type="button"
                        className="recap-thumb-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          setViewing(i);
                        }}
                        aria-label={`View ${a.filename}`}
                        title="View"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          className="recap-thumb"
                          src={`/api/assets/${a.id}/thumb`}
                          alt=""
                          loading="lazy"
                        />
                      </button>
                    </td>
                    <td className="recap-name" title={a.filename}>
                      {a.filename}
                    </td>
                    <td className="recap-pos">
                      {cur ? (
                        <span className="recap-before">
                          {cur.place && `${cur.place} · `}
                          <span className="recap-nowrap">
                            {cur.coord}
                            {a.gps_source && (
                              <span className="hint"> ({a.gps_source})</span>
                            )}
                          </span>
                        </span>
                      ) : (
                        <span className="recap-none">— none —</span>
                      )}
                      <span className="recap-after">
                        {on && target ? `→ ${fmtCoord(target)}` : "unchanged"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );

  const viewed = viewing != null ? listed[viewing] : undefined;

  return (
    <>
      <div className="modal-overlay" role="presentation" {...backdrop}>
        <div
          className={`modal modal-wide recap-modal${onTargetChange ? " has-map" : ""}`}
          role="dialog"
          aria-modal="true"
          aria-label="Confirm geotag"
        >
          <h2 className="modal-title">
            {target ? "Confirm the new position" : "Pick the position"}
          </h2>

          <div className="recap-body">
            {onTargetChange ? (
              <LocationPicker
                layout="split"
                value={target}
                onChange={onTargetChange}
                inputId="recap-place"
                aside={recap}
              />
            ) : (
              recap
            )}
          </div>

          <div className="recap-foot">
            {error && <p className="modal-warn">{error}</p>}
            <div className="modal-actions">
              {skippedExisting > 0 && (
                <span className="hint recap-foot-note">
                  {skippedExisting} media keep their current position.
                </span>
              )}
              <button className="btn" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={submit}
                disabled={busy || count === 0 || !target}
                title={target ? undefined : "Choose a position on the map first"}
              >
                {busy ? "Applying…" : `Apply to ${count} media`}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* A sibling of the overlay, not a child: the viewer portals to <body>,
          but React still bubbles its events up the component tree, and the
          dialog's backdrop and row handlers have no business seeing them. */}
      {viewed && viewing != null && (
        <MediaViewer
          items={listed}
          index={viewing}
          onIndexChange={setViewing}
          onClose={() => setViewing(null)}
          renderActions={(a) => {
            // A pressed button rather than a checkbox: the viewer leaves the
            // keyboard alone while an <input> has focus, so a ticked checkbox
            // would swallow the next Escape and arrow keys.
            const on = checked.has(a.id);
            return (
              <button
                type="button"
                className="btn recap-viewer-check"
                aria-pressed={on}
                disabled={busy}
                onClick={() => toggle(a.id)}
              >
                <span className="recap-viewer-box" aria-hidden="true">
                  {on ? "✓" : ""}
                </span>
                Write this position
              </button>
            );
          }}
        />
      )}
    </>
  );
}
