"use client";

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
  derivative_status?: string;
  rel_path?: string | null;
};

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
  const camera = [asset.camera_model, asset.lens].filter(Boolean).join(" · ");
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
  if (asset.device) rows.push(["Device", asset.device]);
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
  if (asset.derivative_status)
    rows.push(["Derivative", asset.derivative_status]);
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
