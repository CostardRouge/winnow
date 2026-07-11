"use client";

import { friendlyCameraName } from "@/lib/cameraLabels";
import {
  formatBytes,
  formatDateTime,
  formatDimensions,
  formatDuration,
} from "@/lib/format";

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
  derivative_status?: string;
  rel_path?: string | null;
  sidecar_count?: number | null;
};

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
  if (asset.derivative_status)
    rows.push(["Derivative", asset.derivative_status]);
  const sidecars = asset.sidecar_count != null ? Number(asset.sidecar_count) : 0;
  if (sidecars > 0)
    rows.push(["Sidecar", sidecars === 1 ? "1 file" : `${sidecars} files`]);
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
