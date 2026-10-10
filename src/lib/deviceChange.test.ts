// The grids' in-place update after "Set camera body…" (lib/deviceChange.ts) —
// the server's rules restated for the client, so they are pinned here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDeviceChange, deviceSelectionCounts } from "./deviceChange";

const DJI = { device: "DJI FC8482", camera_model: "FC8482" };
const A6700 = { device: "SONY ILCE-6700", camera_model: "ILCE-6700" };

const exifRow = {
  id: 1,
  device: "SONY ILCE-7CM2",
  camera_model: "ILCE-7CM2",
  device_source: "exif",
  device_exif: "SONY ILCE-7CM2",
  camera_model_exif: "ILCE-7CM2",
};
const holeRow = {
  id: 2,
  device: null,
  camera_model: null,
  device_source: null,
  device_exif: null,
  camera_model_exif: null,
};
const filledRow = {
  id: 3,
  device: "DJI FC8482",
  camera_model: "FC8482",
  device_source: "manual",
  device_exif: null,
  camera_model_exif: null,
};

test("fill gives a body to a hole and never touches a body a file declared", () => {
  assert.deepEqual(applyDeviceChange(holeRow, { kind: "fill", body: DJI }), {
    ...holeRow,
    device: "DJI FC8482",
    camera_model: "FC8482",
    device_source: "manual",
  });
  assert.equal(applyDeviceChange(exifRow, { kind: "fill", body: DJI }), exifRow);
});

test("replace overwrites the file's own body and records an override", () => {
  const out = applyDeviceChange(exifRow, { kind: "replace", body: A6700 });
  assert.equal(out.device, "SONY ILCE-6700");
  assert.equal(out.camera_model, "ILCE-6700");
  assert.equal(out.device_source, "override");
  // What the file says is kept, so the viewer can print it and revert has it.
  assert.equal(out.device_exif, "SONY ILCE-7CM2");
});

test("revert restores the file's body, or none where the file names none", () => {
  const overridden = applyDeviceChange(exifRow, { kind: "replace", body: A6700 });
  assert.deepEqual(applyDeviceChange(overridden, { kind: "revert" }), exifRow);
  assert.deepEqual(applyDeviceChange(filledRow, { kind: "revert" }), {
    ...filledRow,
    device: null,
    camera_model: null,
    device_source: null,
  });
  // A body read off the file has nothing to revert to.
  assert.equal(applyDeviceChange(exifRow, { kind: "revert" }), exifRow);
});

test("the dialog's counts only see the selected rows", () => {
  const rows = [exifRow, holeRow, filledRow];
  assert.deepEqual(deviceSelectionCounts(rows, [1, 2, 3]), {
    withoutBody: 1,
    revertible: 1,
  });
  assert.deepEqual(deviceSelectionCounts(rows, [1]), {
    withoutBody: 0,
    revertible: 0,
  });
});

test("revert lands on the body the clip's own track names, where its EXIF names none", () => {
  const clip = {
    ...holeRow,
    id: 4,
    device: "SONY ILCE-6700",
    camera_model: "ILCE-6700",
    device_source: "override",
    embedded_device: "DJI FC8482",
    embedded_camera_model: "FC8482",
  };
  assert.deepEqual(applyDeviceChange(clip, { kind: "revert" }), {
    ...clip,
    device: "DJI FC8482",
    camera_model: "FC8482",
    device_source: "embedded",
  });
  // Already what its track says: nothing to revert, and not counted.
  const read = applyDeviceChange(clip, { kind: "revert" });
  assert.equal(applyDeviceChange(read, { kind: "revert" }), read);
  assert.deepEqual(deviceSelectionCounts([clip, read], [4]), { withoutBody: 0, revertible: 1 });
  assert.deepEqual(deviceSelectionCounts([read], [4]), { withoutBody: 0, revertible: 0 });
});
