// DJI drone flight-log (.SRT) telemetry parsing.
//
// DJI drones write a per-clip subtitle file next to every video (DJI_0001.MP4 →
// DJI_0001.SRT). Despite the .SRT extension it is not captions — each cue packs
// the frame's flight telemetry: GPS, altitude, gimbal, exposure, timecode. We
// parse a representative GPS point (to backfill the clip's location when the
// MP4 itself carries no EXIF GPS — common on drones), the peak altitude/speed
// reached over the clip, a representative gimbal orientation and camera
// exposure (the drone's own EXIF-equivalent — a video container carries none of
// this), and how many samples the track holds.
//
// Two firmware formats are handled:
//   • Modern (Mini/Air/Mavic 3…): bracketed tokens on one line —
//       [iso: 100] [shutter: 1/500.0] [fnum: 280] [focal_len: 24.00]
//       [latitude: 48.858844] [longitude: 2.294351] [rel_alt: 30.1 abs_alt: 120.5]
//       [gb_yaw: 12.3] [gb_pitch: -45.0] [gb_roll: 0.0]
//   • Older (Phantom/Inspire): a per-cue `GPS(<lon>,<lat>,<n>)` with altitude in
//       `BAROMETER:<m>` and ground speed in `H.S:<m>m/S`.
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
  // Representative gimbal orientation in degrees (first sample that carries
  // one) — the camera's aim during the clip, distinct from the aircraft's own
  // attitude.
  gimbalPitch: number | null;
  gimbalYaw: number | null;
  gimbalRoll: number | null;
  // Peak horizontal ground speed in m/s (older-firmware `H.S` field only —
  // modern bracketed logs don't carry speed).
  maxSpeed: number | null;
  // Representative camera exposure for the clip (first sample), from the
  // modern bracketed format only — a video container has no per-frame EXIF, so
  // this is the only place a DJI clip's ISO/shutter/aperture/focal length live.
  iso: number | null;
  shutter: string | null;
  fnumber: number | null;
  focalLength: number | null;
};

const num = "(-?\\d+(?:\\.\\d+)?)";
const LAT_RE = new RegExp(`latitude\\s*[:=]\\s*${num}`, "i");
const LON_RE = new RegExp(`longitude\\s*[:=]\\s*${num}`, "i");
const ABS_ALT_RE = new RegExp(`abs_alt\\s*[:=]?\\s*${num}`, "i");
const REL_ALT_RE = new RegExp(`rel_alt\\s*[:=]?\\s*${num}`, "i");
const ALT_RE = new RegExp(`\\baltitude\\s*[:=]\\s*${num}`, "i");
const BARO_RE = new RegExp(`barometer\\s*[:=]\\s*${num}`, "i");
const GPS_RE = new RegExp(`GPS\\s*\\(\\s*${num}\\s*,\\s*${num}\\s*(?:,\\s*${num})?\\s*\\)`, "i");
const GB_YAW_RE = new RegExp(`gb_yaw\\s*[:=]?\\s*${num}`, "i");
const GB_PITCH_RE = new RegExp(`gb_pitch\\s*[:=]?\\s*${num}`, "i");
const GB_ROLL_RE = new RegExp(`gb_roll\\s*[:=]?\\s*${num}`, "i");
const HS_RE = new RegExp(`H\\.S\\s*[:=]?\\s*${num}\\s*m/S`, "i");
const ISO_RE = new RegExp(`\\biso\\s*[:=]?\\s*(\\d+)`, "i");
const SHUTTER_RE = new RegExp(`shutter\\s*[:=]?\\s*([0-9]+(?:\\.[0-9]+)?(?:/[0-9]+(?:\\.[0-9]+)?)?)`, "i");
// DJI encodes the f-number x100 (280 ⇒ f/2.8).
const FNUM_RE = new RegExp(`fnum\\s*[:=]?\\s*(\\d+)`, "i");
const FOCAL_RE = new RegExp(`focal_len\\s*[:=]?\\s*${num}`, "i");

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

// The gimbal/speed/exposure tokens a cue may carry, independent of whether the
// same line also held a valid GPS fix (kept separate from parseLine so a
// momentary bad/missing fix never drops the rest of the sample's telemetry).
function parseExtras(line: string): {
  gimbalPitch: number | null;
  gimbalYaw: number | null;
  gimbalRoll: number | null;
  speed: number | null;
  iso: number | null;
  shutter: string | null;
  fnumber: number | null;
  focalLength: number | null;
} {
  const n = (m: RegExpMatchArray | null): number | null => {
    if (!m) return null;
    const v = Number(m[1]);
    return Number.isFinite(v) ? v : null;
  };
  const fnum = n(line.match(FNUM_RE));
  return {
    gimbalPitch: n(line.match(GB_PITCH_RE)),
    gimbalYaw: n(line.match(GB_YAW_RE)),
    gimbalRoll: n(line.match(GB_ROLL_RE)),
    speed: n(line.match(HS_RE)),
    iso: n(line.match(ISO_RE)),
    shutter: line.match(SHUTTER_RE)?.[1] ?? null,
    fnumber: fnum != null ? fnum / 100 : null,
    focalLength: n(line.match(FOCAL_RE)),
  };
}

// Parse a DJI .SRT's telemetry. Returns null when the file holds no usable fix
// (an empty log, a non-DJI .srt subtitle, a corrupt file) — the caller then
// simply records the sidecar as an opaque companion, exactly as before.
export function parseDjiSrt(text: string): SrtTelemetry | null {
  let firstLat: number | null = null;
  let firstLon: number | null = null;
  let maxAlt: number | null = null;
  let maxSpeed: number | null = null;
  let count = 0;
  let gimbalPitch: number | null = null;
  let gimbalYaw: number | null = null;
  let gimbalRoll: number | null = null;
  let iso: number | null = null;
  let shutter: string | null = null;
  let fnumber: number | null = null;
  let focalLength: number | null = null;

  for (const line of text.split(/\r?\n/)) {
    const fix = parseLine(line);
    if (fix) {
      count++;
      if (firstLat == null) {
        firstLat = fix.lat;
        firstLon = fix.lon;
      }
      if (fix.alt != null && (maxAlt == null || fix.alt > maxAlt)) maxAlt = fix.alt;
    }

    const extras = parseExtras(line);
    if (extras.speed != null && (maxSpeed == null || extras.speed > maxSpeed))
      maxSpeed = extras.speed;
    // Representative (first-seen) camera/gimbal state — DJI holds these
    // roughly steady across a clip, and a video's EXIF carries none of it.
    if (gimbalPitch == null) gimbalPitch = extras.gimbalPitch;
    if (gimbalYaw == null) gimbalYaw = extras.gimbalYaw;
    if (gimbalRoll == null) gimbalRoll = extras.gimbalRoll;
    if (iso == null) iso = extras.iso;
    if (shutter == null) shutter = extras.shutter;
    if (fnumber == null) fnumber = extras.fnumber;
    if (focalLength == null) focalLength = extras.focalLength;
  }

  if (count === 0) return null;
  return {
    gpsLat: firstLat,
    gpsLon: firstLon,
    maxAltitude: maxAlt,
    sampleCount: count,
    gimbalPitch,
    gimbalYaw,
    gimbalRoll,
    maxSpeed,
    iso,
    shutter,
    fnumber,
    focalLength,
  };
}
