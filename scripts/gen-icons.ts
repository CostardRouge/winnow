/**
 * Generates the PWA raster icons from the SVG sources in public/icons.
 *
 * iOS apple-touch-icons and Android/Chrome maskable icons need real PNGs
 * (SVG support is inconsistent across installers), so we rasterise once here
 * and commit the output. Re-run with `npx tsx scripts/gen-icons.ts` whenever
 * the source SVGs change.
 */
import sharp from "sharp";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const iconsDir = join(here, "..", "public", "icons");

type Job = { src: string; out: string; size: number };

const jobs: Job[] = [
  // Standard "any" icons (Chrome / Android / install prompts).
  { src: "icon.svg", out: "icon-192.png", size: 192 },
  { src: "icon.svg", out: "icon-512.png", size: 512 },
  // Maskable icons (adaptive Android launcher shapes).
  { src: "icon-maskable.svg", out: "icon-maskable-192.png", size: 192 },
  { src: "icon-maskable.svg", out: "icon-maskable-512.png", size: 512 },
  // Apple touch icon (iOS / iPadOS home screen).
  { src: "icon-apple.svg", out: "apple-touch-icon.png", size: 180 },
  // Favicons.
  { src: "icon.svg", out: "favicon-32.png", size: 32 },
  { src: "icon.svg", out: "favicon-16.png", size: 16 },
];

for (const job of jobs) {
  const svg = readFileSync(join(iconsDir, job.src));
  await sharp(svg, { density: 384 })
    .resize(job.size, job.size)
    .png()
    .toFile(join(iconsDir, job.out));
  console.log(`✓ ${job.out} (${job.size}×${job.size})`);
}

console.log("Done.");
