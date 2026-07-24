"use client";

import { friendlyCameraName } from "@/lib/cameraLabels";
import {
  formatBytes,
  formatDateTime,
  formatDimensions,
  formatDuration,
} from "@/lib/format";
import type { SidecarBrief } from "@/lib/types";

// Read-only metadata panel shown inside the full-screen viewer (gallery +
// session grids). Every asset row returned by the API is `assets.*`, so all
// these fields are already present in the payload — this just surfaces the
// useful/missing ones (date, size, dimensions, GPS…) in a consistent layout.
// Fields are all optional so both viewer shapes can pass what they have; rows
// with no value are simply omitted.
export type AssetMetaInput = {
  ext?: string | null;
  media_type?: "photo" | "video";
  captured_at?: string | null;
  file_mtime?: string | null;
  file_size?: number | null;
  width?: number | null;
  height?: number | null;
  duration_s?: number | null;
  device?: string | null;
  camera_model?: string | null;
  lens?: string | null;
  iso?: number | null;
  shutter?: string | null;
  aperture?: number | null;
  focal_length?: number | null;
  gps?: { lat: number; lon: number } | null;
  // DJI drone telemetry embedded in a still's own EXIF/XMP (cf. lib/extract.ts).
  // Null on every non-DJI photo. Video's equivalent comes via `sidecars` below.
  gimbal_pitch?: number | null;
  gimbal_yaw?: number | null;
  gimbal_roll?: number | null;
  relative_altitude?: number | null;
  absolute_altitude?: number | null;
  // Reverse-geocoded place (cf. lib/geocode.ts). Surfaced as one "Location" line.
  place_country?: string | null;
  place_region?: string | null;
  place_county?: string | null;
  place_city?: string | null;
  place_poi?: string | null;
  // ML analysis (cf. lib/ml.ts): detected faces + the text read in the image.
  ml_status?: string | null;
  face_count?: number | null;
  ocr_text?: string | null;
  sharpness?: number | null;
  derivative_status?: string;
  rel_path?: string | null;
  sidecar_count?: number | null;
  // Video sidecars tied to this clip (Sony XML/THM metadata, DJI .SRT flight
  // log). Surfaced as one or two rows with per-file download links; the .SRT is
  // labelled "Telemetry". Falls back to `sidecar_count` when the list is absent.
  sidecars?: SidecarBrief[] | null;
};

// A compact summary of the parsed flight-log figures ("↑ 120 m · 8.2 m/s · gimbal
// -45° · 24mm · f/2.8 · 1/500s · ISO 100 · 900 pts"), or null when nothing was
// parsed. Altitude/speed are peaks across the .srt(s); gimbal/exposure are the
// first clip that carries one (DJI holds them roughly steady per clip); samples
// are summed.
function telemetryFacts(items: SidecarBrief[]): string | null {
  let alt: number | null = null;
  let speed: number | null = null;
  let samples = 0;
  let gimbalPitch: number | null = null;
  let focalLength: number | null = null;
  let fnumber: number | null = null;
  let shutter: string | null = null;
  let iso: number | null = null;
  for (const s of items) {
    if (s.maxAltitude != null && (alt == null || s.maxAltitude > alt))
      alt = s.maxAltitude;
    if (s.maxSpeed != null && (speed == null || s.maxSpeed > speed))
      speed = s.maxSpeed;
    if (s.sampleCount != null) samples += s.sampleCount;
    if (gimbalPitch == null) gimbalPitch = s.gimbalPitch ?? null;
    if (focalLength == null) focalLength = s.focalLength ?? null;
    if (fnumber == null) fnumber = s.fnumber ?? null;
    if (shutter == null) shutter = s.shutter ?? null;
    if (iso == null) iso = s.iso ?? null;
  }
  const parts: string[] = [];
  if (alt != null) parts.push(`↑ ${Math.round(alt)} m`);
  if (speed != null) parts.push(`${speed.toFixed(1)} m/s`);
  if (gimbalPitch != null) parts.push(`gimbal ${Math.round(gimbalPitch)}°`);
  if (focalLength != null) parts.push(`${focalLength}mm`);
  if (fnumber != null) parts.push(`f/${fnumber}`);
  if (shutter != null) parts.push(`${shutter}s`);
  if (iso != null) parts.push(`ISO ${iso}`);
  if (samples > 0) parts.push(`${samples} pts`);
  return parts.length ? parts.join(" · ") : null;
}

// A comma-separated run of sidecar filenames, each a download link to its own
// endpoint. Keyed so React is happy inside a `<dd>`.
function sidecarLinks(items: SidecarBrief[]): React.ReactNode {
  return items.map((s, i) => (
    <span key={s.id}>
      {i > 0 ? " · " : ""}
      <a
        className="asset-meta-link"
        href={`/api/sidecars/${s.id}/download`}
        download
      >
        {s.filename}
      </a>
    </span>
  ));
}

// Join the resolved place into one line, finest → coarsest ("Tour Eiffel · Paris
// · France"), de-duplicating repeats (a city that equals its département).
function locationLine(a: AssetMetaInput): string | null {
  const parts: string[] = [];
  for (const p of [
    a.place_poi,
    a.place_city,
    a.place_county,
    a.place_region,
    a.place_country,
  ]) {
    const s = p?.trim();
    if (s && !parts.includes(s)) parts.push(s);
  }
  return parts.length ? parts.join(" · ") : null;
}

// Joins a DJI still's embedded gimbal/altitude telemetry into one compact line
// ("gimbal -45° · ↑ 30 m rel · 120 m abs"), or null when the photo carries none
// (every non-DJI file, and DJI stills that don't embed the drone-dji tags).
function droneLine(a: AssetMetaInput): string | null {
  const parts: string[] = [];
  if (a.gimbal_pitch != null) parts.push(`gimbal ${Math.round(a.gimbal_pitch)}°`);
  if (a.relative_altitude != null)
    parts.push(`↑ ${Math.round(a.relative_altitude)} m rel`);
  if (a.absolute_altitude != null)
    parts.push(`${Math.round(a.absolute_altitude)} m abs`);
  return parts.length ? parts.join(" · ") : null;
}

// Joins the exposure triangle into one compact line ("50mm · f/2.8 · 1/200s · ISO 400").
function exposureLine(a: AssetMetaInput): string | null {
  const parts = [
    a.focal_length ? `${a.focal_length}mm` : null,
    a.aperture ? `f/${a.aperture}` : null,
    a.shutter ? `${a.shutter}s` : null,
    a.iso ? `ISO ${a.iso}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

export default function AssetMeta({ asset }: { asset: AssetMetaInput }) {
  const camera = [friendlyCameraName(asset.camera_model), asset.lens]
    .filter(Boolean)
    .join(" · ");
  const exposure = exposureLine(asset);
  const dims = formatDimensions(asset.width, asset.height);
  const typeStr = [asset.ext?.replace(/^\./, "").toUpperCase(), asset.media_type]
    .filter(Boolean)
    .join(" · ");

  const rows: Array<[string, React.ReactNode]> = [];
  if (asset.captured_at) rows.push(["Date", formatDateTime(asset.captured_at)]);
  if (camera) rows.push(["Camera", camera]);
  if (exposure) rows.push(["Exposure", exposure]);
  if (dims) rows.push(["Dimensions", dims]);
  if (asset.media_type === "video" && asset.duration_s != null)
    rows.push(["Duration", formatDuration(asset.duration_s)]);
  if (asset.file_size != null) rows.push(["Size", formatBytes(asset.file_size)]);
  if (typeStr) rows.push(["Type", typeStr]);
  if (asset.device) rows.push(["Device", friendlyCameraName(asset.device)]);
  if (asset.gps) {
    const { lat, lon } = asset.gps;
    rows.push([
      "GPS",
      <a
        key="gps"
        className="asset-meta-link"
        href={`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=15/${lat}/${lon}`}
        target="_blank"
        rel="noreferrer"
      >
        {lat.toFixed(5)}, {lon.toFixed(5)}
      </a>,
    ]);
  }
  const location = locationLine(asset);
  if (location) rows.push(["Location", location]);
  const drone = droneLine(asset);
  if (drone) rows.push(["Drone", drone]);
  // ML analysis: only meaningful once analyzed (face_count stays null before).
  if (asset.face_count != null)
    rows.push([
      "Faces",
      asset.face_count === 0
        ? "none detected"
        : asset.face_count === 1
          ? "1 face"
          : `${asset.face_count} faces`,
    ]);
  if (asset.ocr_text) {
    // The fragments are newline-joined; show them as one compact line, capped so
    // a poster full of text can't swallow the panel.
    const text = asset.ocr_text.split("\n").join(" · ");
    rows.push(["Text", text.length > 160 ? `${text.slice(0, 160)}…` : text]);
  }
  // Relative focus score (variance of the Laplacian): shown so the Sharpness
  // range filter has a readable reference ("this blurry shot scored 12").
  if (asset.sharpness != null)
    rows.push(["Sharpness", String(Math.round(asset.sharpness))]);
  if (asset.derivative_status)
    rows.push(["Derivative", asset.derivative_status]);
  // Sidecars: prefer the detailed list (download links, .SRT split out as
  // "Telemetry"); fall back to the bare count when only that is available.
  const sidecarList = asset.sidecars ?? [];
  if (sidecarList.length > 0) {
    const srt = sidecarList.filter((s) => s.kind === "srt");
    const other = sidecarList.filter((s) => s.kind !== "srt");
    if (srt.length > 0) {
      // Surface the parsed flight-log figures next to the download link.
      const facts = telemetryFacts(srt);
      rows.push([
        "Telemetry",
        <span key="tel">
          {sidecarLinks(srt)}
          {facts && <span className="asset-meta-dim"> · {facts}</span>}
        </span>,
      ]);
    }
    if (other.length > 0) rows.push(["Sidecar", sidecarLinks(other)]);
  } else {
    const n = asset.sidecar_count != null ? Number(asset.sidecar_count) : 0;
    if (n > 0) rows.push(["Sidecar", n === 1 ? "1 file" : `${n} files`]);
  }
  if (asset.rel_path) rows.push(["File", asset.rel_path]);

  if (!rows.length) return null;

  return (
    <dl className="asset-meta">
      {rows.map(([label, value]) => (
        <div className="asset-meta-row" key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
