"use client";

// The heatmap's map: one square per geocoding cell, on the shared ramp.
//
// Unlike the gallery's MapView — which plots a marker per asset and caps at
// 10 000 points — this draws one bin per PLACE, so the payload is bounded by
// construction and the whole library is representable at any size. The bins are
// not computed here or on the fly: reverse geocoding already snapped every
// coordinate to `places(cell_lat, cell_lon, precision_m)` at ingest (see the
// header of lib/heat.ts).
//
// Leaflet is imported dynamically by the panel above, not here, so the map
// library stays out of the bundle for anyone who never opens this reading.
import { useCallback, useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { TILE_URL, TILE_ATTRIBUTION } from "@/app/mapTiles";
import type { HeatPlace } from "@/lib/heat";
import { maxOf, rung, type Measure } from "@/lib/heatScale";

// The ramp as literal colours: Leaflet paints into a canvas/SVG layer that
// `var()` cannot reach, so the tokens are read off the document at draw time
// and re-read whenever the theme flips.
function rampColours(): string[] {
  const cs = getComputedStyle(document.documentElement);
  return [0, 1, 2, 3, 4].map(
    (i) => cs.getPropertyValue(`--heat-${i}`).trim() || "#d9442a",
  );
}
function inkColour(): string {
  return (
    getComputedStyle(document.documentElement).getPropertyValue("--color-text").trim() ||
    "#1b1813"
  );
}

export default function HeatBins({
  places,
  measure,
  selected,
  onSelect,
  height,
}: {
  places: HeatPlace[];
  measure: Measure;
  /** The picked bin's place id, if any. */
  selected: number | null;
  onSelect: (id: number | null) => void;
  /** CSS height of the map container. */
  height: number;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const groupRef = useRef<L.LayerGroup | null>(null);
  const fittedRef = useRef(false);
  // Read by the (re-bound per draw) click handlers without going stale.
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const [theme, setTheme] = useState(0);

  // Re-read the ramp when the theme attribute flips (ThemeToggle stamps it on
  // <html>), so the bins follow the paper without a reload.
  useEffect(() => {
    const mo = new MutationObserver(() => setTheme((n) => n + 1));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);

  useEffect(() => {
    if (!hostRef.current || mapRef.current) return;
    const map = L.map(hostRef.current, { worldCopyJump: true, zoomControl: false })
      .setView([20, 0], 2);
    L.tileLayer(TILE_URL, { attribution: TILE_ATTRIBUTION, maxZoom: 19 }).addTo(map);
    groupRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    // A tab switch can leave Leaflet with a stale size (the same trap MapView
    // records) — recompute whenever the container is resized.
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(hostRef.current);
    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      groupRef.current = null;
      fittedRef.current = false;
    };
  }, []);

  const draw = useCallback(() => {
    const map = mapRef.current;
    const group = groupRef.current;
    if (!map || !group) return;
    group.clearLayers();

    const ramp = rampColours();
    const ink = inkColour();
    const max = maxOf(places, measure);
    const pts: L.LatLngExpression[] = [];

    for (const p of places) {
      const v = measure.of(p);
      const r = rung(v, max);
      // Size carries the same measure as colour, deliberately: a lone bright
      // pixel in the Atlantic is easy to miss, and doubling the encoding is
      // what makes the distribution readable at a glance. Square root, so area
      // rather than width tracks the value.
      const norm = max > 0 && v !== null ? Math.min(1, v / max) : 0;
      const px = 10 + 22 * Math.sqrt(norm);
      const marker = L.circleMarker([p.lat, p.lon], {
        radius: px / 2,
        weight: selected === p.id ? 2.5 : 1,
        color: ink,
        opacity: 0.75,
        fillColor: r === null ? ramp[0] : ramp[r],
        fillOpacity: 0.9,
      });
      marker.bindTooltip(
        `<b>${escapeHtml(p.name)}</b><br>${escapeHtml(measure.say(p))}` +
          `<br><span class="heat-tip-dim">${p.c.toLocaleString("en-US")} frames</span>`,
        { className: "heat-tip", direction: "top", offset: [0, -4], opacity: 1 },
      );
      marker.on("click", () => selectRef.current(selected === p.id ? null : p.id));
      group.addLayer(marker);
      pts.push([p.lat, p.lon]);
    }

    // Frame the data once. Refitting on every measure change would yank the map
    // out from under someone comparing two readings of the same view.
    if (pts.length && !fittedRef.current) {
      fittedRef.current = true;
      try {
        map.fitBounds(L.latLngBounds(pts).pad(0.2), { maxZoom: 9 });
      } catch {
        /* a single bin gives degenerate bounds */
      }
    }
  }, [places, measure, selected]);

  useEffect(draw, [draw, theme]);

  return (
    <div
      ref={hostRef}
      className="heat-map"
      style={{ height }}
      role="application"
      aria-label={`Places by ${measure.label.toLowerCase()}`}
    />
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c,
  );
}
