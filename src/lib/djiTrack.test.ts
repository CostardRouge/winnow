// The DJI metadata-track reader (lib/djiTrack.ts) on synthetic clips built
// with the box layout of the real ones (src/test/djiClip.ts). Pure: no
// database, files in a temp directory.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { probeDjiTrack, protobufStrings, readDjiHeader } from "./djiTrack";
import { djiClip, miniHeader, pb } from "../test/djiClip";

let dir: string;
before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "winnow-djitrack-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = async (name: string, data: Buffer) => {
  const p = path.join(dir, name);
  await writeFile(p, data);
  return p;
};

test("a Mini 4 Pro clip names its camera as its stills spell it", async () => {
  const p = await write("DJI_0001.MP4", djiClip());
  assert.deepEqual(await probeDjiTrack(p), {
    protocol: "dvtm_Mini4_Pro.proto",
    model: "DJI Mini4 Pro",
    serial: "1581F6Z9725AW003R0EN",
    camera: "DJI FC8482",
  });
});

test("the first sample is read, through a 64-bit chunk table too", async () => {
  // Per-frame records follow the header; reading any of them instead would
  // name nothing.
  const p = await write("co64.MP4", djiClip({ co64: true, trailing: 50 }));
  assert.equal((await probeDjiTrack(p))?.camera, "DJI FC8482");
});

test("a clip with no DJI track, a truncated clip and a photo say nothing", async () => {
  assert.equal(await probeDjiTrack(await write("phone.MP4", djiClip({ header: null }))), null);
  const whole = djiClip();
  // Cut inside the moov: the box no longer fits the file.
  assert.equal(await probeDjiTrack(await write("cut.MP4", whole.subarray(0, whole.length - 100))), null);
  assert.equal(await probeDjiTrack(await write("x.JPG", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]))), null);
});

test("a missing file is an error, not 'nothing to say'", async () => {
  await assert.rejects(probeDjiTrack(path.join(dir, "gone.MP4")));
});

test("an unknown DJI header keeps its model and serial and names no camera", async () => {
  const p = await write("neo.MP4", djiClip({ header: miniHeader({ protocol: "dvtm_dji_neo.proto", model: "DJI Neo", camera: null }) }));
  assert.deepEqual(await probeDjiTrack(p), {
    protocol: "dvtm_dji_neo.proto",
    model: "DJI Neo",
    serial: "1581F6Z9725AW003R0EN",
    camera: null,
  });
});

test("protobuf strings come back by ExifTool-style field path", () => {
  const s = protobufStrings(miniHeader());
  assert.equal(s.get("1.1.10"), "DJI Mini4 Pro");
  assert.equal(s.get("1.1.5"), "1581F6Z9725AW003R0EN");
  assert.equal(s.get("2.2.1.4"), "DJI FC8482");
  assert.equal(s.get("2.1.3"), "video");
});

test("a header that is not a DJI one is refused", () => {
  assert.equal(readDjiHeader(pb([1, pb([1, pb([1, "hello"])])])), null);
  assert.equal(readDjiHeader(Buffer.from("not protobuf at all\x00\xff")), null);
});
