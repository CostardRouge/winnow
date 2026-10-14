// Out-of-process HEIC/HEIF → JPEG decoder (driven by lib/extract.ts).
//
// heic-decode runs libheif on an Emscripten/WASM module whose linear heap only
// ever GROWS and is never returned to the OS, and libheif-js leaks decoder
// handles across conversions. Decoding thousands of iPhone HEICs inside the
// long-lived worker therefore walks RSS up into multiple GB and never releases
// it. Running each decode in this short-lived child process bounds that: the
// whole address space — WASM heap included — is reclaimed by the OS the instant
// the process exits.
//
// The JPEG is encoded by sharp (native libjpeg), not by heic-convert's pure-JS
// encoder, which spent 1.4 s of a 4.4 s Sony HIF (33 MP) on the instance — the
// WASM decode is the other 2.8 s, and the one cost left. Same output as before:
// full size (derivatives.ts fills a row's missing width/height from it), quality
// 92 (heic-convert's), no chroma subsampling (jpeg-js had none), no metadata.
// libheif has already applied the container's irot/imir; the parent decides
// whether EXIF orientation still applies (cf. readHeicOrientation).
//
// Contract (kept dead simple so the parent can spawn + await it):
//   argv[2] = input  HEIC/HEIF path
//   argv[3] = output JPEG path
//   argv[4] = libvips threads for the encode (the worker's SHARP_CONCURRENCY)
// Exit 0 on success (JPEG written to argv[3]); non-zero with a message on stderr
// otherwise. The parent (lib/extract.ts) treats any failure as "decode failed"
// and falls back to a smaller embedded preview exactly as before.
import { readFile } from "node:fs/promises";

async function main(): Promise<void> {
  const input = process.argv[2];
  const output = process.argv[3];
  if (!input || !output) {
    throw new Error("usage: heicDecode <input.heic> <output.jpg> [threads]");
  }
  const { default: decode } = await import("heic-decode");
  const { default: sharp } = await import("sharp");
  sharp.concurrency(Math.max(1, Number(process.argv[4]) || 1));
  // heic-decode sniffs the brand with String.fromCharCode(...buf.slice(8,12))
  // (needs an iterable byte view) and libheif wants a Uint8Array: the Node
  // Buffer from readFile satisfies both.
  const buffer = await readFile(input);
  const { width, height, data } = await decode({ buffer });
  await sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
    raw: { width, height, channels: 4 },
  })
    .removeAlpha()
    .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
    .toFile(output);
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error((err as Error)?.message ?? String(err));
    process.exit(1);
  },
);
