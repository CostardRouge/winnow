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
import { exiftool, type WriteTags } from "exiftool-vendored";
import { VIDEO_EXTS } from "./config";
import { one, q } from "./db";

export type GpsPoint = { lat: number; lon: number };

// Write the coordinates into `absPath`'s metadata.
//   - photos: the four standard EXIF GPS tags (signed value + hemisphere ref);
//   - videos: QuickTime `GPSCoordinates` ("lat lon", the Keys atom Apple and
//     exiftool's composite GPSLatitude/GPSLongitude read back).
// Flags: -overwrite_original_in_place edits the file without leaving exiftool's
// `basename_original` backup next to it (it would be indexed as a duplicate);
// -P preserves the file's mtime so the watcher/indexer doesn't see a "changed"
// file and re-walk the session for a tag-only edit.
export async function writeGps(
  absPath: string,
  ext: string,
  gps: GpsPoint,
): Promise<void> {
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
    : {
        GPSLatitude: Math.abs(gps.lat),
        GPSLatitudeRef: gps.lat >= 0 ? "N" : "S",
        GPSLongitude: Math.abs(gps.lon),
        GPSLongitudeRef: gps.lon >= 0 ? "E" : "W",
      };

  await exiftool.write(absPath, tags, {
    writeArgs: ["-overwrite_original_in_place", "-P"],
  });
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
  }>(
    "SELECT abs_path, ext, gps_lat, gps_lon, deleted_at, missing_at FROM assets WHERE id = $1",
    [assetId],
  );
  // Gone, trashed, missing from disk, or coordinates cleared since the enqueue:
  // nothing to write. Terminal, not an error.
  if (
    !asset ||
    asset.deleted_at ||
    asset.missing_at ||
    asset.gps_lat == null ||
    asset.gps_lon == null
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
    await q(
      "UPDATE assets SET gps_write_status='error', gps_write_error=$2, updated_at=now() WHERE id=$1",
      [assetId, (err as Error).message?.slice(0, 500) ?? "unknown error"],
    );
    throw err;
  }
}
