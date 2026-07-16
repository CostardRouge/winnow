// DJI drone flight-log (.SRT) telemetry parsing.
//
// DJI drones write a per-clip subtitle file next to every video (DJI_0001.MP4 →
// DJI_0001.SRT). Despite the .SRT extension it is not captions — each cue packs
// the frame's flight telemetry: GPS, altitude, gimbal, exposure, timecode. We
// parse only what we surface today: a representative GPS point (to backfill the
// clip's location when the MP4 itself carries no EXIF GPS — common on drones),
// the peak altitude, and how many samples the track holds.
//
// Two firmware formats are handled:
//   • Modern (Mini/Air/Mavic 3…): bracketed tokens on one line —
//       [latitude: 48.858844] [longitude: 2.294351] [rel_alt: 30.1 abs_alt: 120.5]
//   • Older: a per-cue `GPS(<lon>,<lat>,<n>)` with altitude in `BAROMETER:<m>`.
// Coordinates are range-validated (lat ∈ [-90,90], lon ∈ [-180,180]); an
// implausible pair is swapped once, then dropped — telemetry is a nicety, never
// worth storing a wrong location.

export type SrtTelemetry = {
  // First valid fix in the track — the point we tag the clip with.
  gpsLat: number | null;
  gpsLon: number | null;
  // Peak altitude in metres (absolute if the log gives it, else relative).
  maxAltitude: number | null;
  // How many telemetry samples carried a valid GPS fix.
  sampleCount: number;
};

const num = "(-?\\d+(?:\\.\\d+)?)";
const LAT_RE = new RegExp(`latitude\\s*[:=]\\s*${num}`, "i");
const LON_RE = new RegExp(`longitude\\s*[:=]\\s*${num}`, "i");
const ABS_ALT_RE = new RegExp(`abs_alt\\s*[:=]?\\s*${num}`, "i");
const REL_ALT_RE = new RegExp(`rel_alt\\s*[:=]?\\s*${num}`, "i");
const ALT_RE = new RegExp(`\\baltitude\\s*[:=]\\s*${num}`, "i");
const BARO_RE = new RegExp(`barometer\\s*[:=]\\s*${num}`, "i");
const GPS_RE = new RegExp(`GPS\\s*\\(\\s*${num}\\s*,\\s*${num}\\s*(?:,\\s*${num})?\\s*\\)`, "i");

function validCoord(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180 &&
    // Drop the null island (0,0): a "no fix yet" placeholder, not a real point.
    !(lat === 0 && lon === 0)
  );
}

// A single flight-log fix, if the line carries one.
function parseLine(line: string): { lat: number; lon: number; alt: number | null } | null {
  const latM = line.match(LAT_RE);
  const lonM = line.match(LON_RE);
  let lat: number | null = null;
  let lon: number | null = null;

  if (latM && lonM) {
    lat = Number(latM[1]);
    lon = Number(lonM[1]);
  } else {
    // Older format: GPS(<longitude>,<latitude>,<n>) — DJI writes longitude first.
    const g = line.match(GPS_RE);
    if (g) {
      lon = Number(g[1]);
      lat = Number(g[2]);
    }
  }
  if (lat == null || lon == null) return null;

  if (!validCoord(lat, lon)) {
    // One salvage attempt: the two may be swapped (firmware ordering varies).
    if (validCoord(lon, lat)) [lat, lon] = [lon, lat];
    else return null;
  }

  const altM =
    line.match(ABS_ALT_RE) ??
    line.match(REL_ALT_RE) ??
    line.match(ALT_RE) ??
    line.match(BARO_RE);
  const alt = altM ? Number(altM[1]) : null;
  return { lat, lon, alt: alt != null && Number.isFinite(alt) ? alt : null };
}

// Parse a DJI .SRT's telemetry. Returns null when the file holds no usable fix
// (an empty log, a non-DJI .srt subtitle, a corrupt file) — the caller then
// simply records the sidecar as an opaque companion, exactly as before.
export function parseDjiSrt(text: string): SrtTelemetry | null {
  let firstLat: number | null = null;
  let firstLon: number | null = null;
  let maxAlt: number | null = null;
  let count = 0;

  for (const line of text.split(/\r?\n/)) {
    const fix = parseLine(line);
    if (!fix) continue;
    count++;
    if (firstLat == null) {
      firstLat = fix.lat;
      firstLon = fix.lon;
    }
    if (fix.alt != null && (maxAlt == null || fix.alt > maxAlt)) maxAlt = fix.alt;
  }

  if (count === 0) return null;
  return {
    gpsLat: firstLat,
    gpsLon: firstLon,
    maxAltitude: maxAlt,
    sampleCount: count,
  };
}
