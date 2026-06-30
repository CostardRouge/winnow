"use client";

// iPhone Live Photo preview — shared helpers for surfacing the motion (the
// companion .mov) wherever a Live Photo's still is shown: the gallery grid, the
// Sift swipe deck, its recent strip and the full-screen viewer.
//
// A Live Photo is a still `primary` paired with a `.mov` `companion` (cf.
// lib/pairing.ts). The still is what every surface already renders; the motion
// is the companion asset's video proxy, played muted + looping over the still on
// hover (desktop) or an explicit tap (touch), Apple-style.

import type { CSSProperties } from "react";

// A row carries enough pairing info to know it's a Live Photo with playable
// motion. Every grid/deck row already includes these (GRID_SELECT / DeckCard).
export type LivePhotoLike = {
  group_kind?: "raw_jpeg" | "live_photo" | null;
  companion_id?: number | null;
  companion_media_type?: "photo" | "video" | null;
};

// True when the asset is a Live Photo whose motion companion is reachable.
export function isLivePhoto(a: LivePhotoLike): boolean {
  return (
    a.group_kind === "live_photo" &&
    a.companion_id != null &&
    a.companion_media_type === "video"
  );
}

// The motion clip URL (the companion .mov's mp4 proxy) for a Live Photo.
export function liveMotionSrc(companionId: number): string {
  return `/api/assets/${companionId}/proxy`;
}

// The motion overlay: a muted, looping video laid over the still. Mounted only
// while active (hover/tap) so it isn't fetched for every tile; unmounting stops
// playback and frees the element. Pointer-events stay off so the host surface
// keeps its click / drag behaviour. `fit` matches the still's object-fit so the
// motion lines up exactly with the frame it replaces.
export function LiveMotionVideo({
  companionId,
  poster,
  fit = "cover",
  style,
}: {
  companionId: number;
  poster?: string;
  fit?: "cover" | "contain";
  style?: CSSProperties;
}) {
  return (
    <video
      className="live-video"
      style={{ objectFit: fit, ...style }}
      src={liveMotionSrc(companionId)}
      poster={poster}
      autoPlay
      muted
      loop
      playsInline
      preload="none"
    />
  );
}
