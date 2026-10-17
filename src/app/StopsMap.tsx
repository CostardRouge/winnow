"use client";

import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { TILE_ATTRIBUTION, TILE_URL } from "@/app/mapTiles";

// The map of the stops dialog (StopsDialog, docs/UNPLACED.md §11): one
// NUMBERED pin per stop, the active stop's pin drawn heavier, and — when the
// stops come from a followed track — the track's line and a dot per frame
// where it lands. Controlled: the dialog owns the pins; this draws them and
// reports a click (a new point for the active stop) or a drag (a pin moved).
// Leaflet touches `window` on import: hosts load it through `next/dynamic`.

export type MapStop = {
  key: string;
  number: number;
  lat: number;
  lon: number;
  active: boolean;
  /** Pins of a followed track are measurements: never dragged. */
  draggable: boolean;
};

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
const wrapLon = (v: number) => ((((v + 180) % 360) + 360) % 360) - 180;

function icon(n: number, active: boolean): L.DivIcon {
  return L.divIcon({
    className: "stop-pin-wrap",
    html: `<span class="stop-pin${active ? " is-active" : ""}">${n}</span>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

export default function StopsMap({
  stops,
  line,
  dots,
  onPick,
  onMove,
}: {
  stops: MapStop[];
  line?: { lat: number; lon: number }[];
  dots?: { lat: number; lon: number }[];
  /** A click on the map: the point for the active stop. Omit for read-only. */
  onPick?: (lat: number, lon: number) => void;
  onMove?: (key: string, lat: number, lon: number) => void;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const trackRef = useRef<L.LayerGroup | null>(null);
  const fitted = useRef(false);
  // Handlers bound once with the map read the latest props through refs.
  const pickRef = useRef(onPick);
  const moveRef = useRef(onMove);
  useEffect(() => {
    pickRef.current = onPick;
    moveRef.current = onMove;
  }, [onPick, onMove]);

  useEffect(() => {
    const box = boxRef.current;
    if (!box || mapRef.current) return;
    // Each map gets a container of its own inside the box, and is removed a
    // frame AFTER its unmount: Leaflet's canvas renderer can have a redraw
    // already scheduled, which its removal fails to cancel — it then fires on
    // a canvas with no context ("reading 'clearRect' of undefined"), on every
    // StrictMode remount and on a close right after opening (traced
    // 2026-10-17 in Leaflet 1.9.4). The next map mounts meanwhile on a fresh
    // container, so the two never share one.
    const el = document.createElement("div");
    el.className = "stops-map-pane";
    box.appendChild(el);
    const map = L.map(el, { zoomControl: true, preferCanvas: true });
    map.setView([20, 0], 2);
    L.tileLayer(TILE_URL, { attribution: TILE_ATTRIBUTION, maxZoom: 19 }).addTo(map);
    map.on("click", (e: L.LeafletMouseEvent) => {
      pickRef.current?.(round6(e.latlng.lat), round6(wrapLon(e.latlng.lng)));
    });
    trackRef.current = L.layerGroup().addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(box);
    return () => {
      ro.disconnect();
      mapRef.current = null;
      fitted.current = false;
      el.style.display = "none";
      requestAnimationFrame(() => {
        map.remove();
        el.remove();
      });
    };
  }, []);

  // The track and the frames: drawn once per change, under the pins.
  useEffect(() => {
    const g = trackRef.current;
    if (!g) return;
    g.clearLayers();
    if (line && line.length > 1) {
      L.polyline(
        line.map((p) => [p.lat, p.lon] as [number, number]),
        { className: "stop-track", weight: 3, interactive: false },
      ).addTo(g);
    }
    for (const d of dots ?? []) {
      L.circleMarker([d.lat, d.lon], {
        radius: 3,
        className: "stop-dot",
        interactive: false,
      }).addTo(g);
    }
  }, [line, dots]);

  // The pins, redrawn from the dialog's state on every change.
  useEffect(() => {
    const map = mapRef.current;
    const g = layerRef.current;
    if (!map || !g) return;
    g.clearLayers();
    for (const s of stops) {
      const m = L.marker([s.lat, s.lon], {
        icon: icon(s.number, s.active),
        draggable: s.draggable && !!moveRef.current,
        keyboard: false,
        zIndexOffset: s.active ? 1000 : 0,
      }).addTo(g);
      m.on("dragend", () => {
        const p = m.getLatLng();
        moveRef.current?.(s.key, round6(p.lat), round6(wrapLon(p.lng)));
      });
    }
    // Frame everything once, on the first draw that has something to frame;
    // after that the human owns the viewport.
    if (!fitted.current) {
      const pts: [number, number][] = [
        ...stops.map((s) => [s.lat, s.lon] as [number, number]),
        ...(line ?? []).map((p) => [p.lat, p.lon] as [number, number]),
      ];
      if (pts.length) {
        fitted.current = true;
        if (pts.length === 1) map.setView(pts[0], 13);
        else map.fitBounds(L.latLngBounds(pts), { padding: [32, 32], maxZoom: 14 });
      }
    }
  }, [stops, line]);

  return <div className="stops-map" ref={boxRef} />;
}
