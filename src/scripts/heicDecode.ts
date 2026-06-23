// Out-of-process HEIC/HEIF → JPEG decoder (driven by lib/extract.ts).
//
// heic-convert runs libheif on an Emscripten/WASM module whose linear heap only
// ever GROWS and is never returned to the OS, and libheif-js leaks decoder
// handles across conversions. Decoding thousands of iPhone HEICs inside the
// long-lived worker therefore walks RSS up into multiple GB and never releases
// it. Running each decode in this short-lived child process bounds that: the
// whole address space — WASM heap included — is reclaimed by the OS the instant
// the process exits.
//
// Contract (kept dead simple so the parent can spawn + await it):
//   argv[2] = input  HEIC/HEIF path
//   argv[3] = output JPEG path
// Exit 0 on success (JPEG written to argv[3]); non-zero with a message on stderr
// otherwise. The parent (lib/extract.ts) treats any failure as "decode failed"
// and falls back to a smaller embedded preview exactly as before.
import { readFile, writeFile } from "node:fs/promises";

async function main(): Promise<void> {
  const input = process.argv[2];
  const output = process.argv[3];
  if (!input || !output) {
    throw new Error("usage: heicDecode <input.heic> <output.jpg>");
  }
  const { default: heicConvert } = await import("heic-convert");
  const buffer = await readFile(input);
  // heic-decode sniffs the brand with String.fromCharCode(...buf.slice(8,12))
  // (needs an iterable byte view) and libheif wants a Uint8Array: the Node
  // Buffer from readFile satisfies both. The published @types claim
  // ArrayBufferLike, which is wrong for the runtime — hence the cast.
  const jpeg = await heicConvert({
    buffer: buffer as unknown as ArrayBufferLike,
    format: "JPEG",
  });
  await writeFile(output, Buffer.from(jpeg));
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error((err as Error)?.message ?? String(err));
    process.exit(1);
  },
);
