// Lightweight, dependency-free image scoring for ML-assisted culling (Phase 1).
//
// Both metrics run on the already-decoded PROXY bytes via sharp/libvips — the
// RAW is never re-read (the guiding principle: touch the RAW only once). No
// model download, no native ML runtime: pure classic computer vision, so this
// works on the same `node:slim` worker image and CPU-only Optiplex as the rest.
//
//   sharpnessScore — variance of the Laplacian. A flat/blurry frame has little
//     high-frequency energy (low variance); a crisp one has a lot. Computed on a
//     fixed-size greyscale render so the score is comparable across source
//     resolutions. It is a RELATIVE measure (rank within a burst), not an
//     absolute pass/fail: deliberate bokeh or motion blur scores low by design.
//
//   perceptualHash — 64-bit DCT hash (the classic pHash). Resize to 32x32 grey,
//     take the 2-D DCT, keep the 8x8 low-frequency block, threshold each
//     coefficient against the block's median. Near-identical images yield hashes
//     a few bits apart (small Hamming distance), robust to scaling, mild
//     compression and small tonal shifts. Returned as 16 lowercase hex chars.
import sharp from "sharp";

// Working size for the Laplacian. Big enough to preserve fine detail, small
// enough that the single JS pass over the pixels is sub-millisecond.
const SHARP_WORK = 1024;
// DCT side for the perceptual hash (32 -> keep the top-left 8x8).
const PHASH_SIZE = 32;
const PHASH_LOW = 8;

// Single-channel greyscale pixels of `buf` resized to fit within `size`x`size`.
// `.greyscale()` desaturates but does NOT by itself collapse the raw output to
// one band, so we force a one-channel colourspace and, defensively, de-interleave
// to channel 0 if libvips still hands back multiple bands — otherwise the
// Laplacian / DCT would read interleaved RGB and produce garbage.
async function greyRaw(
  buf: Buffer,
  size: number,
  fit: "inside" | "fill",
): Promise<{ data: Uint8Array; width: number; height: number }> {
  const { data, info } = await sharp(buf, { failOn: "none" })
    .greyscale()
    .toColourspace("b-w")
    .resize(size, size, { fit, withoutEnlargement: fit === "inside" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  if (channels === 1) return { data, width, height };
  const grey = new Uint8Array(width * height);
  for (let i = 0; i < grey.length; i++) grey[i] = data[i * channels];
  return { data: grey, width, height };
}

// Variance of the 3x3 Laplacian response over the interior pixels. Returns 0 for
// a degenerate (too small) image rather than throwing.
export async function sharpnessScore(buf: Buffer): Promise<number> {
  const { data, width: w, height: h } = await greyRaw(buf, SHARP_WORK, "inside");
  if (w < 3 || h < 3) return 0;

  // Laplacian kernel [[0,1,0],[1,-4,1],[0,1,0]]. Welford-free two-pass-in-one:
  // accumulate sum and sum-of-squares of the response, then variance.
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = row + x;
      const lap =
        data[i - w] + data[i + w] + data[i - 1] + data[i + 1] - 4 * data[i];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  const variance = sumSq / n - mean * mean;
  // Clamp tiny negative drift from floating-point rounding.
  return variance > 0 ? variance : 0;
}

// --- DCT perceptual hash --------------------------------------------------

// Precomputed 1-D DCT-II basis: COS[k][x] = cos((2x+1)kπ / 2N). Built once.
const COS: number[][] = (() => {
  const N = PHASH_SIZE;
  const table: number[][] = [];
  for (let k = 0; k < N; k++) {
    const rowK: number[] = new Array(N);
    for (let x = 0; x < N; x++) {
      rowK[x] = Math.cos(((2 * x + 1) * k * Math.PI) / (2 * N));
    }
    table.push(rowK);
  }
  return table;
})();

// 2-D DCT-II of an NxN matrix, computed separably (rows then columns). We only
// ever need the top-left PHASH_LOW x PHASH_LOW block, so the column pass is
// limited to those output rows — O(N^2 * (N + LOW)) instead of O(N^3).
function dctLowBlock(pixels: Float64Array, N: number, low: number): number[] {
  // Pass 1: DCT along each row -> `rows[y*N + u]`.
  const rows = new Float64Array(N * N);
  for (let y = 0; y < N; y++) {
    const base = y * N;
    for (let u = 0; u < N; u++) {
      const cu = COS[u];
      let acc = 0;
      for (let x = 0; x < N; x++) acc += pixels[base + x] * cu[x];
      rows[base + u] = acc;
    }
  }
  // Pass 2: DCT along each column, but only for the `low` lowest output rows.
  const block: number[] = [];
  for (let v = 0; v < low; v++) {
    const cv = COS[v];
    for (let u = 0; u < low; u++) {
      let acc = 0;
      for (let y = 0; y < N; y++) acc += rows[y * N + u] * cv[y];
      block.push(acc);
    }
  }
  return block;
}

// 64-bit DCT perceptual hash as 16 lowercase hex chars.
export async function perceptualHash(buf: Buffer): Promise<string> {
  const { data } = await greyRaw(buf, PHASH_SIZE, "fill");
  const N = PHASH_SIZE;
  const pixels = new Float64Array(N * N);
  // `fill` guarantees exactly N*N pixels; guard anyway.
  for (let i = 0; i < N * N; i++) pixels[i] = data[i] ?? 0;

  const block = dctLowBlock(pixels, N, PHASH_LOW); // 64 coefficients

  // Median over the block EXCLUDING the DC term (block[0]): the DC dominates and
  // would skew the threshold, washing the hash out.
  const ac = block.slice(1).sort((a, b) => a - b);
  const mid = ac.length >> 1;
  const median =
    ac.length % 2 ? ac[mid] : (ac[mid - 1] + ac[mid]) / 2;

  // Bit i (MSB first) = coefficient i above the median.
  let hash = 0n;
  for (let i = 0; i < block.length; i++) {
    hash <<= 1n;
    if (block[i] > median) hash |= 1n;
  }
  return hash.toString(16).padStart(16, "0");
}

// Hamming distance between two 16-hex (64-bit) perceptual hashes. Returns 64
// (max distance) when either side is missing/malformed, so a bad hash never
// reads as "identical".
export function hammingDistance(a: string | null, b: string | null): number {
  if (!a || !b) return 64;
  let xa: bigint;
  let xb: bigint;
  try {
    xa = BigInt(`0x${a}`);
    xb = BigInt(`0x${b}`);
  } catch {
    return 64;
  }
  let x = xa ^ xb;
  let dist = 0;
  while (x) {
    x &= x - 1n; // clear the lowest set bit
    dist++;
  }
  return dist;
}
