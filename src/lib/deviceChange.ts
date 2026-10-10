// The client-side mirror of a camera-body write (cf. lib/deviceAttribution.ts):
// what a grid shows after "Set camera body…" confirms, without refetching.
//
// Pure and dependency-free on purpose. The dialog and both grids are client
// components, so these cannot live in lib/deviceAttribution.ts, which imports
// the database; and they are the rules the SERVER applied, restated — kept in
// one module, beside a test, so the two grids cannot drift from each other or
// from the write.

/** A body as the picker offers it: the raw EXIF string and its bare model. */
export type BodyRef = { device: string; camera_model: string | null };

/** What a confirmed dialog did. */
export type DeviceChange =
  | { kind: "fill"; body: BodyRef }
  | { kind: "replace"; body: BodyRef }
  | { kind: "revert" };

/** The slice of a grid row the dialog reads and rewrites. Grid rows are
 *  `a.*`, so every host already has these. */
export type DeviceRow = {
  id: number;
  device?: string | null;
  camera_model?: string | null;
  device_source?: string | null;
  device_exif?: string | null;
  camera_model_exif?: string | null;
  /** The camera the clip's own metadata track names (migration 0049). */
  embedded_device?: string | null;
  embedded_camera_model?: string | null;
};

/** What "Revert to the files" puts back: the EXIF body, else the one the
 *  clip's track names, else none — lib/deviceAttribution.ts revertDevice. */
function fileBody(row: DeviceRow): {
  device: string | null;
  camera_model: string | null;
  device_source: string | null;
} {
  if (row.device_exif)
    return {
      device: row.device_exif,
      camera_model: row.camera_model_exif ?? null,
      device_source: "exif",
    };
  if (row.embedded_device)
    return {
      device: row.embedded_device,
      camera_model: row.embedded_camera_model ?? null,
      device_source: "embedded",
    };
  return { device: null, camera_model: null, device_source: null };
}

/** True when revert would change this row. */
function revertible(row: DeviceRow): boolean {
  if (!row.device_source || row.device_source === "exif") return false;
  const f = fileBody(row);
  return (row.device ?? null) !== f.device || row.device_source !== f.device_source;
}

/** The two counts the dialog opens with, from rows the host already holds. */
export function deviceSelectionCounts(
  rows: readonly DeviceRow[],
  ids: readonly number[],
): { withoutBody: number; revertible: number } {
  const idset = new Set(ids);
  let withoutBody = 0;
  let n = 0;
  for (const a of rows) {
    if (!idset.has(a.id)) continue;
    if (!a.device) withoutBody++;
    // Anything not read off the file itself can go back to the file.
    if (revertible(a)) n++;
  }
  return { withoutBody, revertible: n };
}

/**
 * One row after a confirmed dialog, by the rules the server applied:
 *   fill    — only a row with no body gets one ('manual'), keeping a model the
 *             file did declare;
 *   replace — every row gets the body ('override'), the file's own included;
 *   revert  — a row whose body did not come off its file goes back to what the
 *             file says: its EXIF ('exif'), else the camera its metadata track
 *             names ('embedded'), else no body.
 */
export function applyDeviceChange<T extends DeviceRow>(
  row: T,
  change: DeviceChange,
): T {
  if (change.kind === "fill")
    return row.device
      ? row
      : {
          ...row,
          device: change.body.device,
          camera_model: row.camera_model ?? change.body.camera_model,
          device_source: "manual",
        };
  if (change.kind === "replace")
    return {
      ...row,
      device: change.body.device,
      camera_model: change.body.camera_model,
      device_source: "override",
    };
  if (!revertible(row)) return row;
  return { ...row, ...fileBody(row) };
}
