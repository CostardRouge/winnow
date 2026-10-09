// The vote of lib/deviceAttribution.ts on its own — pure, no database. The
// weights and the bar are printed on the Devices page, so what they decide is
// pinned here: no single signal is confident, two independent ones are.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIDENT_SCORE, SIGNAL_WEIGHTS, scoreCandidate } from "./deviceAttribution";

const row = (over: Partial<Parameters<typeof scoreCandidate>[0]> = {}) => ({
  id: 1,
  filename: "clip.mp4",
  rel_path: "clip.mp4",
  ext: "mp4",
  media_type: "video" as const,
  file_size: null,
  width: null,
  height: null,
  duration_s: null,
  derivative_status: "ready",
  captured_at: null,
  session_name: null,
  session_path: "/nas/2026/holiday",
  has_sidecar: false,
  has_telemetry: false,
  sibling_device: null,
  sibling_camera_model: null,
  ...over,
});

test("no single signal clears the confidence bar", () => {
  for (const w of Object.values(SIGNAL_WEIGHTS)) assert.ok(w < CONFIDENT_SCORE);
});

test("a parsed flight log is confident on its own file, with its .SRT", () => {
  const r = scoreCandidate(row({ has_sidecar: true, has_telemetry: true }));
  assert.deepEqual(r.signals, ["telemetry", "sidecar"]);
  assert.ok(r.score >= CONFIDENT_SCORE);
});

test("the maker's name and the folder's name are matched case-blind, on word edges", () => {
  assert.deepEqual(scoreCandidate(row({ filename: "dji_0042.MP4" })).signals, ["filename"]);
  assert.deepEqual(scoreCandidate(row({ session_path: "/nas/2026/DJI Drone" })).signals, ["folder"]);
  // "dronet" is not a drone, and a DJI_ inside a name is not the scheme.
  assert.deepEqual(scoreCandidate(row({ session_path: "/nas/dronet", filename: "x_dji_1.mp4" })).signals, []);
});

test("a sibling body plus one more signal is confident; the sibling alone is not", () => {
  const sib = { sibling_device: "DJI FC8482", sibling_camera_model: "FC8482" };
  assert.ok(scoreCandidate(row(sib)).score < CONFIDENT_SCORE);
  assert.ok(scoreCandidate(row({ ...sib, filename: "DJI_0001.MP4" })).score >= CONFIDENT_SCORE);
});
