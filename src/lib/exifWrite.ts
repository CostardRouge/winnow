// GPS write-back into the ORIGINAL file (cf. api/assets/geotag). The one place
// winnow deliberately modifies a source file: a manual geotag is only durable if
// it lives in the file itself — the Capture One export is a plain byte copy
// (lib/export.ts), so coordinates written here travel to the finals for free,
// and a future re-index reads the same value back (DB and file stay coherent).
//
// Tag-only edit through exiftool — the image/video stream is never re-encoded.
// Same vendored binary as lib/extract.ts, so the writable formats match what we
// read (JPEG/HEIC/TIFF-based RAW/QuickTime…); exiftool refuses unwritable
// containers with an error the gpswrite job surfaces as gps_write_status='error'.
import { createReadStream, createWriteStream, type Stats } from "node:fs";
import { stat, unlink, utimes } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { ExifTool, type WriteTags } from "exiftool-vendored";
import { VIDEO_EXTS } from "./config";
import { one, q } from "./db";
import { readMetadata } from "./extract";
import { sameContent } from "./hash";

export type GpsPoint = { lat: number; lon: number };

// Writes get an exiftool of their own, because the shared one (lib/extract.ts)
// kills any task that passes 30 s — exiftool-vendored's default — and a write
// is the one task that must never be killed halfway (audit BE-05). With
// -overwrite_original_in_place exiftool copies the whole file into
// `<file>_exiftool_tmp`, then copies that back OVER the original: four times
// the file in NAS I/O, about 1 GB per 30 s on the instance, so every clip over
// ~1 GB was killed (2026-10-13: six clips, 0.9–7.9 GB). Killed in the first
// copy it leaves a tmp that fails every later write; killed in the second it
// leaves an original that is half the new version and half the old one, which
// ffprobe still reads — two of three were, measured with cmp. A 0 timeout
// would say "never", but exiftool-vendored 37 refuses to start with it, so the
// bound is one no write reaches (a 7.9 GB clip takes minutes) and batch-cluster
// wants the process age at least as long. A write that hangs holds the
// gpswrite queue, which shows as a pending count; it never cuts an original.
const WRITE_TIMEOUT_MS = 6 * 60 * 60 * 1000;
let writer: ExifTool | null = null;
export function exifWriter(): ExifTool {
  writer ??= new ExifTool({
    maxProcs: 1,
    taskTimeoutMillis: WRITE_TIMEOUT_MS,
    maxProcAgeMillis: WRITE_TIMEOUT_MS,
  });
  return writer;
}
export async function closeExifWriter(): Promise<void> {
  const w = writer;
  writer = null;
  if (w) await w.end();
}

// exiftool's own name for its working copy of `absPath`.
export const exiftoolTmp = (absPath: string) => `${absPath}_exiftool_tmp`;

// "The same file, give or take a tag": a GPS write moved the instance's clips
// by 18 and 106 bytes. A copy killed in its first pass is far shorter than the
// original — the case this keeps from ever being copied over it.
const COPY_SLACK_BYTES = 64 * 1024;

/**
 * Settles what an earlier, killed write left beside `absPath` (a worker
 * restart can still kill one), before a new write — which exiftool refuses
 * while its tmp exists ("Temporary file already exists"). The order of the two
 * mtimes says how far the dead write got, because exiftool stamps the finished
 * tmp with the original's dates (-P) BEFORE copying it back:
 *   - original no newer than the tmp: the copy-back never touched it (or ended
 *     and restored its date). The tmp is scratch: removed, the write goes on.
 *   - original newer: the copy-back had started, the original is a hybrid. It
 *     is finished from the tmp — what exiftool was writing — only when the tmp
 *     is provably the complete result of THIS write: about the original's size,
 *     readable, holding exactly `gps`. Then there is nothing left to write.
 *     Otherwise nothing is touched and the error names both files (the
 *     maintainer's call, 2026-10-14: finish it rather than ask for SSH).
 * One writer process and a gpswrite concurrency of 1: no write of ours can be
 * running on that tmp while this runs.
 */
async function settleLeftover(
  absPath: string,
  gps: GpsPoint,
): Promise<"none" | "removed" | "completed"> {
  const tmp = exiftoolTmp(absPath);
  const left = await stat(tmp).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  if (!left) return "none";
  const orig = await stat(absPath);
  if (orig.mtimeMs <= left.mtimeMs) {
    await unlink(tmp);
    return "removed";
  }
  const why = await notOurCompleteCopy(tmp, left, orig, gps);
  if (why)
    throw new Error(
      `An earlier write was interrupted while exiftool copied its result back into this original, which may be damaged; Winnow cannot finish it from ${path.basename(tmp)} beside it (${why}). Nothing was touched: compare the two files, keep the good one, delete the other, then retry.`,
    );
  await finishCopyBack(tmp, absPath, left);
  return "completed";
}

async function notOurCompleteCopy(
  tmp: string,
  left: Stats,
  orig: Stats,
  gps: GpsPoint,
): Promise<string | null> {
  if (Math.abs(left.size - orig.size) > COPY_SLACK_BYTES)
    return `it is ${left.size} bytes and the original ${orig.size}`;
  let held: GpsPoint | null;
  try {
    held = (await readMetadata(tmp)).gps;
  } catch (err) {
    return `exiftool cannot read it: ${(err as Error).message}`;
  }
  if (!held) return "it holds no position";
  if (Math.abs(held.lat - gps.lat) > 1e-5 || Math.abs(held.lon - gps.lon) > 1e-5)
    return `it holds ${held.lat}, ${held.lon}, not the ${gps.lat}, ${gps.lon} being written`;
  return null;
}

// exiftool's own last step, done by hand: the tmp's bytes into the original IN
// PLACE (a truncating open keeps its inode, owner and mode, which a rename
// would not — the reason for -overwrite_original_in_place), checked byte for
// byte, the dates exiftool stamped on the tmp put back, the tmp removed. A kill
// in the middle leaves the same state as before, and the next attempt redoes it.
async function finishCopyBack(tmp: string, absPath: string, left: Stats) {
  await pipeline(createReadStream(tmp), createWriteStream(absPath));
  if ((await sameContent(absPath, tmp)) !== true)
    throw new Error(`the copy of ${tmp} into the original did not verify; both kept`);
  await utimes(absPath, left.atime, left.mtime);
  await unlink(tmp);
}

// A plain-words cause ahead of exiftool's, for the refusal no retry can fix
// (cf. ffmpegHint in lib/video.ts). exiftool rewrites the whole file, so it
// refuses one whose image data ends early — on the instance, two ARWs of 29 and
// 11 MB beside 38 MB neighbours, cut copies — and that refusal is what kept
// them from being made worse. Exported for the tests.
export function gpsWriteHint(message: string): string {
  return /Error reading image data/.test(message)
    ? "Damaged original: its image data ends early (an incomplete or corrupt copy) — nothing was written. Copy it again from the source, then retry. "
    : "";
}

// Write the coordinates into `absPath`'s metadata.
//   - photos: the four standard EXIF GPS tags (signed value + hemisphere ref
//     — the sign is what the library reads, see below);
//   - videos: QuickTime `GPSCoordinates` ("lat lon", the Keys atom Apple and
//     exiftool's composite GPSLatitude/GPSLongitude read back).
// Flags: -overwrite_original_in_place edits the file without leaving exiftool's
// `basename_original` backup next to it (it would be indexed as a duplicate);
// -P preserves the file's mtime (the capture-time fallback of a file that
// carries no date, and what a file browser sorts on). It does NOT hide the
// edit from the indexer: the stat gate compares size AND mtime, the new tag
// grows the file (~106 bytes on a Sony clip), so the next scan re-reads it
// once — which is also how the database reads the written value back. Two
// clips of the same length given the same pin then share their partial hash;
// lib/indexer.ts's re-index handles that collision.
export async function writeGps(
  absPath: string,
  ext: string,
  gps: GpsPoint,
): Promise<"written" | "completed"> {
  if (!Number.isFinite(gps.lat) || !Number.isFinite(gps.lon)) {
    throw new Error(`invalid coordinates: ${gps.lat}, ${gps.lon}`);
  }
  if (Math.abs(gps.lat) > 90 || Math.abs(gps.lon) > 180) {
    throw new Error(`coordinates out of range: ${gps.lat}, ${gps.lon}`);
  }

  const isVideo = VIDEO_EXTS.has(ext.toLowerCase());
  const tags: WriteTags = isVideo
    ? // QuickTime containers keep GPS in one combined Keys tag.
      { GPSCoordinates: `${gps.lat} ${gps.lon}` }
    : // SIGNED values, with the matching refs. exiftool-vendored derives the
      // hemisphere ref from the sign of the value it is given and overrides
      // an explicit one: the unsigned values written here until 2026-10-09
      // put every pin West or South into the file as N/E — Brittany filed
      // in Seine-et-Marne, Streaky Bay at 33° N in the Pacific — and the
      // next re-index read the mirror back into the database.
      // exifWrite.test.ts writes and re-reads all four hemispheres.
      {
        GPSLatitude: gps.lat,
        GPSLatitudeRef: gps.lat >= 0 ? "N" : "S",
        GPSLongitude: gps.lon,
        GPSLongitudeRef: gps.lon >= 0 ? "E" : "W",
      };

  // A killed write's leftovers first; an interrupted copy-back of these very
  // coordinates, once finished, leaves nothing to write.
  if ((await settleLeftover(absPath, gps)) === "completed") return "completed";
  await exifWriter().write(absPath, tags, {
    writeArgs: ["-overwrite_original_in_place", "-P"],
  });
  return "written";
}

// The gpswrite queue job (cf. worker.ts): write one asset's current coordinates
// into its original file, tracking the lifecycle in gps_write_status. Reads the
// coordinates at RUN time, not enqueue time — geotagging twice before the worker
// catches up simply writes the latest value.
export async function runGpsWriteJob(assetId: number): Promise<void> {
  const asset = await one<{
    abs_path: string;
    ext: string;
    gps_lat: number | null;
    gps_lon: number | null;
    deleted_at: string | null;
    missing_at: string | null;
    gps_source: string | null;
  }>(
    "SELECT abs_path, ext, gps_lat, gps_lon, deleted_at, missing_at, gps_source FROM assets WHERE id = $1",
    [assetId],
  );
  // Gone, trashed, missing from disk, or coordinates cleared since the enqueue:
  // nothing to write. Terminal, not an error. Nor when the position is no
  // longer a hand-placed pin: the job reads the coordinates at run time, so a
  // manual pin queued (or retrying) and then overwritten by an accepted
  // suggestion would have written that bulk guess into the original — the
  // one thing 'inferred' must never do (docs/UNPLACED.md §4.3).
  if (
    !asset ||
    asset.deleted_at ||
    asset.missing_at ||
    asset.gps_lat == null ||
    asset.gps_lon == null ||
    asset.gps_source !== "manual"
  ) {
    await q(
      "UPDATE assets SET gps_write_status='skipped', gps_write_error=NULL, updated_at=now() WHERE id=$1",
      [assetId],
    );
    return;
  }

  await q(
    "UPDATE assets SET gps_write_status='processing', updated_at=now() WHERE id=$1",
    [assetId],
  );
  try {
    await writeGps(asset.abs_path, asset.ext, {
      lat: asset.gps_lat,
      lon: asset.gps_lon,
    });
    await q(
      "UPDATE assets SET gps_write_status='ready', gps_write_error=NULL, updated_at=now() WHERE id=$1",
      [assetId],
    );
  } catch (err) {
    const message = (err as Error).message ?? "unknown error";
    await q(
      "UPDATE assets SET gps_write_status='error', gps_write_error=$2, updated_at=now() WHERE id=$1",
      [assetId, `${gpsWriteHint(message)}${message}`.slice(0, 500)],
    );
    throw err;
  }
}
