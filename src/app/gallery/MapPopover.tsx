"use client";

// Content of the popover that opens when a map marker is clicked (cf. MapView).
// The map itself only knows { id, lat, lon } per point — everything readable
// about the media (when, where, with what) is fetched here, on open, for that
// one asset: the geo payload plots the whole filtered library at once, so it
// deliberately carries no metadata beyond the coordinates.
//
// Three things happen in this small card:
//   - a video plays IN PLACE (its proxy, with native controls) instead of
//     forcing a trip through the full-screen viewer just to hear a clip;
//   - one click on a photo — or the explicit "Open in viewer" button on either
//     kind — hands the asset to the media viewer;
//   - capture date, resolved place and device are spelled out, so a dot on the
//     map identifies itself without being opened at all.
import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { locationLine, type AssetMetaInput } from "./AssetMeta";
import { friendlyCameraName } from "@/lib/cameraLabels";
import { formatDateTime, formatDuration } from "@/lib/format";
import { fetchJson } from "@/lib/fetchJson";
import { Icons } from "@/app/ui";

// What the popover needs off the asset row. `/api/assets/:id` answers with the
// full grid projection, so this is just the subset we read from it.
export type MapPopAsset = AssetMetaInput & {
  id: number;
  filename: string;
};

export default function MapPopover({
  id,
  video: videoHint,
  onLayout,
  onOpen,
}: {
  id: number;
  /** Marker-level hint from the geo payload, so a clip shows its play
   *  affordance immediately rather than after the detail fetch lands. */
  video?: boolean;
  /** Called whenever the rendered card changes shape, so the host can let the
   *  map re-measure it (it is mounted into a popup that opened empty). */
  onLayout?: () => void;
  onOpen: (id: number) => void;
}) {
  const [asset, setAsset] = useState<MapPopAsset | null>(null);
  const [failed, setFailed] = useState(false);
  // Playback is opt-in: the poster (the thumbnail we already have) stands in
  // until the user asks for the clip, so opening a popover never pulls an mp4.
  const [playing, setPlaying] = useState(false);
  const [thumbBroken, setThumbBroken] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setAsset(null);
    setFailed(false);
    setPlaying(false);
    setThumbBroken(false);
    fetchJson<{ asset: MapPopAsset }>(`/api/assets/${id}`)
      .then((d) => !cancelled && setAsset(d.asset))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Mount, the details landing, playback starting: each grows or reflows the
  // card, and the map has to know (it sized the bubble around what it saw).
  useLayoutEffect(() => {
    onLayout?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset, failed, playing, thumbBroken]);

  const isVideo = asset ? asset.media_type === "video" : Boolean(videoHint);
  // The detail row tells us whether the derivatives exist at all; before it
  // lands we optimistically show the thumbnail and fall back on its error.
  const noThumb = thumbBroken || (asset != null && asset.derivative_status !== "ready");

  const facts: Array<[string, ReactNode]> = [];
  if (asset) {
    const when = asset.captured_at ?? asset.file_mtime;
    if (when) facts.push(["Date", formatDateTime(when)]);
    // Resolved place when the geocoder has been through, raw coordinates
    // otherwise — a point on the map always has those.
    const place =
      locationLine(asset) ??
      (asset.gps ? `${asset.gps.lat.toFixed(4)}, ${asset.gps.lon.toFixed(4)}` : null);
    if (place) facts.push(["Place", place]);
    const device = friendlyCameraName(asset.device ?? asset.camera_model);
    if (device) facts.push(["Device", device]);
  }

  return (
    <div className="map-pop">
      {isVideo && playing ? (
        <video
          className="map-pop-media"
          src={`/api/assets/${id}/proxy`}
          poster={`/api/assets/${id}/thumb`}
          controls
          autoPlay
          playsInline
          preload="metadata"
        />
      ) : (
        <button
          type="button"
          className="map-pop-media map-pop-thumb"
          onClick={() => (isVideo ? setPlaying(true) : onOpen(id))}
          title={isVideo ? "Play the clip here" : "Open in the media viewer"}
          aria-label={isVideo ? "Play the clip here" : "Open in the media viewer"}
        >
          {noThumb ? (
            <span className="map-pop-noThumb">
              {asset?.derivative_status === "error" ? "⚠ error" : "no preview"}
            </span>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/assets/${id}/thumb`}
              alt=""
              loading="lazy"
              decoding="async"
              onError={() => setThumbBroken(true)}
            />
          )}
          {isVideo && (
            <>
              <span className="map-pop-play" aria-hidden>
                ▶
              </span>
              {asset?.duration_s != null && (
                <span className="map-pop-dur">{formatDuration(asset.duration_s)}</span>
              )}
            </>
          )}
        </button>
      )}

      <div className="map-pop-body">
        {asset && (
          <p className="map-pop-name" title={asset.filename}>
            {asset.filename}
          </p>
        )}
        {failed ? (
          <p className="map-pop-hint">Couldn’t load the details</p>
        ) : !asset ? (
          <p className="map-pop-hint">Loading details…</p>
        ) : facts.length ? (
          <dl className="map-pop-facts">
            {facts.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="map-pop-hint">No capture metadata</p>
        )}
        <button type="button" className="btn map-pop-open" onClick={() => onOpen(id)}>
          {Icons.view}
          Open in viewer
        </button>
      </div>
    </div>
  );
}
