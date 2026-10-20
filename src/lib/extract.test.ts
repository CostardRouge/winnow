// The capture-time re-read on real files: no database needed, only the
// exiftool that ships with exiftool-vendored.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  closeExiftool,
  demosaicArgs,
  extractSourceJpeg,
  readCaptureTimeFromFile,
  sniffDirectRaster,
} from "./extract";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "../test/fixtures");

after(async () => {
  await closeExiftool();
});

test("a camera clip's date is read although its moov comes after the media data", async () => {
  // Written like a Sony, DJI or iPhone clip: `mdat` first, `moov` (and its
  // CreateDate) last. exiftool -fast2 stops at `mdat` and reads no date.
  const c = await readCaptureTimeFromFile(path.join(fixtures, "camera-moov-last.mp4"));
  assert.ok(c.captured_at, "the clip's CreateDate is read");
  assert.equal(new Date(c.captured_at).toISOString(), "2025-07-07T21:30:18.000Z");
  assert.equal(c.captured_at_source, "exif");
});

// --- Derivative sources: the files the embedded-preview path cannot serve ---

// A DNG reduced to what Adobe's iOS camera SDK leaves in its files: one IFD
// holding the raw CFA and nothing else — no JpgFromRaw, no PreviewImage, no
// ThumbnailImage. Little-endian TIFF, 64×32 RGGB (LibRaw refuses anything
// under 22 px a side), 16-bit, uncompressed, Orientation 6 (90° CW) so the
// test also sees who rotates.
function previewlessDng(): Buffer {
  const W = 64, H = 32;
  const entries: Array<[tag: number, type: number, count: number, value: Buffer]> = [];
  const short = (...v: number[]) => { const b = Buffer.alloc(v.length * 2); v.forEach((x, i) => { b.writeUInt16LE(x, i * 2); }); return b; };
  const long = (...v: number[]) => { const b = Buffer.alloc(v.length * 4); v.forEach((x, i) => { b.writeUInt32LE(x, i * 4); }); return b; };
  const srational = (...v: Array<[number, number]>) => { const b = Buffer.alloc(v.length * 8); v.forEach(([n, d], i) => { b.writeInt32LE(n, i * 8); b.writeInt32LE(d, i * 8 + 4); }); return b; };
  const ascii = (t: string) => Buffer.from(`${t}\0`, "latin1");
  const SHORT = 3, LONG = 4, ASCII = 2, BYTE = 1, SRATIONAL = 10;
  const pixels = Buffer.alloc(W * H * 2);
  for (let i = 0; i < W * H; i++) pixels.writeUInt16LE(1500, i * 2);
  entries.push(
    [254, LONG, 1, long(0)],
    [256, SHORT, 1, short(W)],
    [257, SHORT, 1, short(H)],
    [258, SHORT, 1, short(16)],
    [259, SHORT, 1, short(1)],
    [262, SHORT, 1, short(32803)], // Color Filter Array
    [271, ASCII, 7, ascii("Winnow")],
    [272, ASCII, 5, ascii("Test")],
    [273, LONG, 1, long(0)], // StripOffsets, patched below
    [274, SHORT, 1, short(6)],
    [277, SHORT, 1, short(1)],
    [278, SHORT, 1, short(H)],
    [279, LONG, 1, long(pixels.length)],
    [284, SHORT, 1, short(1)],
    [33421, SHORT, 2, short(2, 2)],
    [33422, BYTE, 4, Buffer.from([0, 1, 1, 2])],
    [50706, BYTE, 4, Buffer.from([1, 4, 0, 0])],
    [50708, ASCII, 12, ascii("Winnow Test")],
    [50717, SHORT, 1, short(4095)],
    [50721, SRATIONAL, 9, srational([1, 1], [0, 1], [0, 1], [0, 1], [1, 1], [0, 1], [0, 1], [0, 1], [1, 1])],
    [50730, SRATIONAL, 1, srational([1, 1])], // BaselineExposure +1 EV
    [50778, SHORT, 1, short(21)],
  );
  const ifdSize = 2 + entries.length * 12 + 4;
  let extra = 8 + ifdSize;
  const blobs: Buffer[] = [];
  const ifd = Buffer.alloc(ifdSize);
  ifd.writeUInt16LE(entries.length, 0);
  const stripOffsetAt = { pos: 0 };
  entries.forEach(([tag, type, count, value], i) => {
    const at = 2 + i * 12;
    ifd.writeUInt16LE(tag, at);
    ifd.writeUInt16LE(type, at + 2);
    ifd.writeUInt32LE(count, at + 4);
    if (tag === 273) stripOffsetAt.pos = at + 8;
    if (value.length <= 4) value.copy(ifd, at + 8);
    else {
      ifd.writeUInt32LE(extra, at + 8);
      blobs.push(value);
      extra += value.length + (value.length % 2);
      if (value.length % 2) blobs.push(Buffer.alloc(1));
    }
  });
  ifd.writeUInt32LE(extra, stripOffsetAt.pos);
  const header = Buffer.from([0x49, 0x49, 42, 0, 8, 0, 0, 0]);
  return Buffer.concat([header, ifd, ...blobs, pixels]);
}

const hasDcraw = !spawnSync("dcraw_emu", [], { stdio: "ignore" }).error;

test("a RAW that embeds no preview is demosaiced instead of failing", { skip: !hasDcraw && "dcraw_emu (libraw-bin) not installed" }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "winnow-test-"));
  try {
    const dng = path.join(dir, "NOPREVIEW.DNG");
    await writeFile(dng, previewlessDng());
    const src = await extractSourceJpeg(dng, ".dng");
    try {
      const m = await sharp(src.jpegPath).metadata();
      // Half size, and already rotated by LibRaw: 64×32 landscape → 16×32.
      assert.equal(m.width, 16);
      assert.equal(m.height, 32);
      assert.equal(src.orientation, undefined, "the worker must not rotate a second time");
    } finally {
      if (src.cleanupDir) await rm(src.cleanupDir, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a JPEG saved under a .HEIC name goes straight to sharp", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "winnow-test-"));
  try {
    // Apple Photos / Photomator write an edit's rendition this way (IMG_E….HEIC).
    const file = path.join(dir, "IMG_E0001.HEIC");
    await sharp({ create: { width: 12, height: 8, channels: 3, background: "#808080" } })
      .jpeg()
      .toFile(file);
    const src = await extractSourceJpeg(file, ".heic");
    assert.equal(src.jpegPath, file);
    assert.equal(src.cleanupDir, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A Sony A7C II .HIF embeds an 8 KB EXIF thumbnail and nothing larger, so every
// one goes through the full libheif decode (measured on the instance: 4.4 s, of
// which 1.4 s was a pure-JS JPEG encoder until 2026-10-14). The fixture is the
// same kind of file, 96×64: HEVC 10-bit 4:2:2, no preview, left half red and
// right half blue — encoded with libheif's heif-enc (x265).
test("a HIF with no usable preview is decoded out of process, full size, colours intact", async () => {
  const src = await extractSourceJpeg(path.join(fixtures, "sony-like-10bit-422.hif"), ".hif");
  try {
    const img = sharp(src.jpegPath);
    const meta = await img.metadata();
    assert.equal(meta.format, "jpeg");
    // Full size: derivatives.ts fills a row's missing width/height from it.
    assert.deepEqual([meta.width, meta.height], [96, 64]);
    const { data, info } = await img.removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => [...data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3)];
    const [lr, , lb] = px(10, 32);
    const [rr, , rb] = px(86, 32);
    assert.ok(lr > 150 && lb < 100, `left is red: ${px(10, 32)}`);
    assert.ok(rb > 150 && rr < 100, `right is blue: ${px(86, 32)}`);
  } finally {
    if (src.cleanupDir) await rm(src.cleanupDir, { recursive: true, force: true });
  }
});

test("the sniffer never takes a TIFF-based RAW for a direct raster", () => {
  assert.equal(sniffDirectRaster(previewlessDng().subarray(0, 12)), null);
  assert.equal(sniffDirectRaster(Buffer.from([0x4d, 0x4d, 0, 42, 0, 0, 0, 8])), null);
  assert.equal(sniffDirectRaster(Buffer.from([0xff, 0xd8, 0xff, 0xe1])), "jpeg");
  assert.equal(sniffDirectRaster(Buffer.from("RIFF\0\0\0\0WEBP", "latin1")), "webp");
  assert.equal(sniffDirectRaster(Buffer.alloc(0)), null);
});

test("the demosaic applies the DNG's baseline exposure, bounded to LibRaw's range", () => {
  assert.ok(!demosaicArgs("a", "b", 0).includes("-aexpo"));
  const at = (ev: number) => {
    const a = demosaicArgs("a", "b", ev);
    return Number(a[a.indexOf("-aexpo") + 1]);
  };
  assert.equal(at(1), 2);
  assert.equal(at(1.25), 2.378);
  assert.equal(at(5), 8);
  assert.equal(at(-4), 0.25);
  const args = demosaicArgs("in.dng", "out.tiff", 0);
  assert.deepEqual(args.slice(-3), ["-Z", "out.tiff", "in.dng"]);
});
