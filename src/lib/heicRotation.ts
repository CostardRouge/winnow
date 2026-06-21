// Detection of HEIC/HEIF derivatives that the pre-fix worker rotated twice.
//
// libheif (heic-convert) applies the HEIF container transform (irot/imir) when
// decoding and ignores EXIF, but the old worker ALSO re-applied the EXIF
// Orientation on top. An asset was double-rotated iff its original carries BOTH
// a container transform AND an EXIF Orientation that maps to a real angle
// (3=180°, 6=90°, 8=270°). Those are the thumbnails/proxies that look sideways
// or upside-down and must be regenerated with the fixed code.
//
// Shared by the CLI (src/scripts/heic-rotation.ts) and the Pipeline UI so both
// use the exact same criterion. Reads metadata only (exiftool) — no pixel decode.
import { many } from "./db";
import { HEIC_EXTS } from "./config";
import { readHeicOrientation } from "./orientation";
import { stat } from "node:fs/promises";

// EXIF orientations the worker actually rotated for (cf. ORIENTATION_ANGLE in
// derivatives.ts). 1/2/4/5/7 produced a 0° angle, so they were never affected.
const ROTATING = new Set([3, 6, 8]);

// Concurrent metadata reads. exiftool-vendored pools internally; this just keeps
// the in-flight set bounded so a big library can't queue everything at once.
const SCAN_CONCURRENCY = 8;

// Emit a progress update every N files examined (plus first/last).
const PROGRESS_EVERY = 20;

export type HeicRotationItem = {
  id: number;
  filename: string;
  abs_path: string;
  ext: string;
  // The EXIF orientation that was wrongly re-applied (3 / 6 / 8).
  orientation: number;
};

export type HeicRotationReport = {
  scanned: number; // ready HEIC/HEIF photos examined
  missing: number; // originals not reachable this run (NAS offline, moved, …)
  affected: HeicRotationItem[]; // double-rotated, full list
};

// UI/job-facing shape: the report plus derived counts, with the affected list
// capped for display (affectedIds stays exhaustive so "Fix all" covers all).
export type HeicRotationResult = {
  scanned: number;
  missing: number;
  ok: number;
  affectedCount: number;
  items: HeicRotationItem[];
  itemsCapped: boolean;
  affectedIds: number[];
};

// Cap the rows carried with paths so a huge backlog can't bloat the job result
// stored in Redis (or the API response).
const ITEM_CAP = 500;

export function buildHeicRotationResult(
  r: HeicRotationReport,
): HeicRotationResult {
  return {
    scanned: r.scanned,
    missing: r.missing,
    ok: r.scanned - r.affected.length - r.missing,
    affectedCount: r.affected.length,
    items: r.affected.slice(0, ITEM_CAP),
    itemsCapped: r.affected.length > ITEM_CAP,
    affectedIds: r.affected.map((a) => a.id),
  };
}

// Run `fn` over `items` with at most `limit` in flight, preserving order.
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return out;
}

// Examine every `ready` HEIC/HEIF photo and flag the double-rotated ones. Pure
// read: never mutates the DB nor touches the derivatives — callers decide what
// to do with the result (the CLI/UI re-queue via the regenerate path).
// `onProgress` is called (throttled) as files are examined, for the job's
// progress bar.
export async function scanHeicRotation(opts?: {
  onProgress?: (processed: number, total: number) => void;
}): Promise<HeicRotationReport> {
  const rows = await many<{
    id: number;
    filename: string;
    abs_path: string;
    ext: string;
  }>(
    `SELECT id, filename, abs_path, ext
       FROM assets
      WHERE deleted_at IS NULL
        AND media_type = 'photo'
        AND lower(ext) = ANY($1)
        AND derivative_status = 'ready'
      ORDER BY id`,
    [[...HEIC_EXTS]],
  );

  let missing = 0;
  const affected: HeicRotationItem[] = [];

  // Throttled progress: report at the start, every PROGRESS_EVERY files, and at
  // the end — enough for a live bar without hammering Redis on every file.
  const total = rows.length;
  let done = 0;
  opts?.onProgress?.(0, total);
  const bump = () => {
    done++;
    if (done % PROGRESS_EVERY === 0 || done === total) {
      opts?.onProgress?.(done, total);
    }
  };

  const results = await mapLimit(rows, SCAN_CONCURRENCY, async (r) => {
    try {
      // Skip files that are currently offline (NAS unmounted, etc.) rather than
      // guessing — they simply aren't evaluated this run.
      try {
        await stat(r.abs_path);
      } catch {
        return { kind: "missing" as const };
      }
      const { exif, containerRotated } = await readHeicOrientation(r.abs_path);
      if (containerRotated && exif !== undefined && ROTATING.has(exif)) {
        return {
          kind: "affected" as const,
          item: {
            id: r.id,
            filename: r.filename,
            abs_path: r.abs_path,
            ext: r.ext,
            orientation: exif,
          },
        };
      }
      return { kind: "ok" as const };
    } finally {
      bump();
    }
  });

  for (const res of results) {
    if (res.kind === "missing") missing++;
    else if (res.kind === "affected") affected.push(res.item);
  }

  return { scanned: rows.length, missing, affected };
}
