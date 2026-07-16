// Video sidecars (cf. migrations 0015 Sony XML/THM, 0017 DJI SRT).
//
// Sony cameras (A7C II / XAVC-S) write a small metadata companion next to every
// video clip — C0001.MP4 → C0001M01.XML — the "NRT" (non-real-time) metadata:
// real capture time, GPS, recording mode, codec… Other cameras instead drop a
// per-clip thumbnail (C0001.THM) or a plain <base>.XML, and DJI drones drop a
// per-clip telemetry/subtitle track (DJI_0001.SRT). These satellites are NOT
// media: we never index them as their own assets and never build derivatives
// for them. Instead we keep each one TIED to its video so it travels with the
// clip through import, export and purge (the same "carry the companion"
// philosophy as RAW+JPEG pairing in lib/pairing.ts).
//
// Detection is purely by NAME, relative to a video file in the same directory:
//   <base>.MP4   ⇒   <base>M01.XML   (Sony NRT metadata; M01/M02… reels)
//                    <base>.XML
//                    <base>.THM
//                    <base>.SRT      (DJI flight-log subtitles)
import path from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import { q } from "./db";
import { parseDjiSrt, type SrtTelemetry } from "./srt";

export type SidecarKind = "xml" | "thm" | "srt";

const SIDECAR_EXTS: Record<string, SidecarKind> = {
  ".xml": "xml",
  ".thm": "thm",
  // DJI drones drop a per-clip telemetry/subtitle file (DJI_0001.SRT) next to
  // the video — the exact-base form `sidecarSuffix` already matches.
  ".srt": "srt",
};

export type SidecarMatch = {
  // The sidecar's own filename, exactly as found on disk.
  filename: string;
  kind: SidecarKind;
  // The trailing part of the name AFTER the shared video base (e.g. "M01.XML"
  // or ".THM"). When a video is renamed on import (collision suffix), the
  // sidecar can be renamed to `${newBase}${suffix}` so the base⇔base link our
  // own detection relies on is preserved.
  suffix: string;
};

// Filename minus its extension (the "base"). `C0001.MP4` → `C0001`.
function baseOf(filename: string): string {
  const ext = path.extname(filename);
  return ext ? filename.slice(0, filename.length - ext.length) : filename;
}

// If `siblingName` is a sidecar of the video whose base is `videoBase`, return
// the suffix that follows the base (case preserved); otherwise null. Matches
// both the exact-base form (<base>.xml/.thm) and Sony's reel form (<base>M01).
export function sidecarSuffix(
  videoBase: string,
  siblingName: string,
): string | null {
  const ext = path.extname(siblingName).toLowerCase();
  if (!(ext in SIDECAR_EXTS)) return null;
  const sibBase = siblingName.slice(0, siblingName.length - ext.length);
  const lowBase = videoBase.toLowerCase();
  const lowSib = sibBase.toLowerCase();
  // Exact base: C0001.MP4 ⇒ C0001.XML / C0001.THM.
  if (lowSib === lowBase) return siblingName.slice(videoBase.length);
  // Sony reel suffix: C0001.MP4 ⇒ C0001M01.XML (M01, M02 …).
  if (lowSib.startsWith(lowBase)) {
    const tail = sibBase.slice(videoBase.length);
    if (/^M\d{2}$/i.test(tail)) return siblingName.slice(videoBase.length);
  }
  return null;
}

// Every sidecar of `videoFilename` among `siblings` (filenames in the same dir).
export function findSidecars(
  videoFilename: string,
  siblings: string[],
): SidecarMatch[] {
  const base = baseOf(videoFilename);
  const out: SidecarMatch[] = [];
  for (const name of siblings) {
    if (name === videoFilename) continue;
    const suffix = sidecarSuffix(base, name);
    if (suffix == null) continue;
    out.push({
      filename: name,
      kind: SIDECAR_EXTS[path.extname(name).toLowerCase()],
      suffix,
    });
  }
  return out;
}

// List the (file) names sitting next to `absPath`, or null if the directory
// can't be read. Optionally memoized through `cache` so a session with many
// clips reads each directory only once.
async function siblingNames(
  dir: string,
  cache?: Map<string, string[]>,
): Promise<string[] | null> {
  const hit = cache?.get(dir);
  if (hit) return hit;
  let names: string[];
  try {
    names = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch {
    return null;
  }
  cache?.set(dir, names);
  return names;
}

export type RecordSidecarsResult = {
  // How many sidecars are now tied to the asset.
  recorded: number;
  // The representative GPS fix parsed from a DJI .SRT flight log, if any — the
  // indexer uses it to backfill the clip's location when the MP4 has no EXIF GPS.
  gps: { lat: number; lon: number } | null;
};

// Parse a .SRT flight log's telemetry, best-effort. A read/parse failure yields
// null — the sidecar is still recorded as an opaque companion.
async function readSrtTelemetry(abs: string): Promise<SrtTelemetry | null> {
  try {
    const text = await readFile(abs, "utf8");
    return parseDjiSrt(text);
  } catch {
    return null;
  }
}

// Detect and (idempotently) record the sidecars of a freshly indexed VIDEO
// asset. Returns the count plus any GPS fix parsed from a DJI .SRT (for the
// indexer's location backfill). Keyed on the sidecar's abs_path so re-indexing
// the same clip never duplicates rows; a renamed/moved sidecar updates in place.
// Never throws into the indexer — a sidecar is a nicety, never a reason to fail
// a media file's indexing.
export async function recordSidecars(opts: {
  assetId: number;
  absPath: string;
  rootPath: string;
  dirCache?: Map<string, string[]>;
}): Promise<RecordSidecarsResult> {
  const { assetId, absPath, rootPath, dirCache } = opts;
  const dir = path.dirname(absPath);
  const siblings = await siblingNames(dir, dirCache);
  if (!siblings) return { recorded: 0, gps: null };

  const matches = findSidecars(path.basename(absPath), siblings);
  let recorded = 0;
  let gps: { lat: number; lon: number } | null = null;
  for (const m of matches) {
    const abs = path.join(dir, m.filename);
    let size: number | null = null;
    try {
      size = (await stat(abs)).size;
    } catch {
      /* removed between the listing and now: record with a null size */
    }
    // DJI flight log: parse GPS/altitude/sample-count off the .SRT so the viewer
    // can show it and the clip can inherit the drone's location.
    const tel = m.kind === "srt" ? await readSrtTelemetry(abs) : null;
    if (tel && tel.gpsLat != null && tel.gpsLon != null && !gps)
      gps = { lat: tel.gpsLat, lon: tel.gpsLon };
    try {
      await q(
        `INSERT INTO asset_sidecars
           (asset_id, abs_path, rel_path, filename, kind, file_size,
            gps_lat, gps_lon, max_altitude, sample_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (abs_path) DO UPDATE SET
           asset_id = EXCLUDED.asset_id, rel_path = EXCLUDED.rel_path,
           filename = EXCLUDED.filename, kind = EXCLUDED.kind,
           file_size = EXCLUDED.file_size, gps_lat = EXCLUDED.gps_lat,
           gps_lon = EXCLUDED.gps_lon, max_altitude = EXCLUDED.max_altitude,
           sample_count = EXCLUDED.sample_count, updated_at = now()`,
        [
          assetId,
          abs,
          path.relative(rootPath, abs),
          m.filename,
          m.kind,
          size,
          tel?.gpsLat ?? null,
          tel?.gpsLon ?? null,
          tel?.maxAltitude ?? null,
          tel?.sampleCount ?? null,
        ],
      );
      recorded++;
    } catch (err) {
      console.warn(`Unable to record sidecar ${abs}:`, (err as Error).message);
    }
  }
  return { recorded, gps };
}
