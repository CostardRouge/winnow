"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { Icons } from "@/app/ui";
import { TILE_URL, TILE_ATTRIBUTION } from "@/app/mapTiles";
import MapPopover from "./MapPopover";

// Map view for the gallery: plots every geotagged asset (a point per asset),
// and lets the user carve out a zone — either the current viewport or a
// hand-drawn box — to pick / reject / export the media inside it. The zone is
// expressed as a bounding box that the rest of the app treats as just another
// cumulative filter (see lib/filter.ts `bbox`).
//
// Clicking a point opens a preview popover (MapPopover: thumbnail or inline
// video, capture facts, and a hand-off to the full-screen viewer). It is ONE
// standalone Leaflet popup moved from marker to marker rather than a popup bound
// to each of the (up to 10k) markers: the content is React, portalled into the
// popup's DOM node, so it survives the marker layer being cleared and rebuilt
// whenever the filters change the point set.

export type GeoPoint = {
  id: number;
  lat: number;
  lon: number;
  /** Clip rather than still (cf. api/assets/geo) — drives the popover's play
   *  affordance before its detail fetch resolves. Absent on photos. */
  video?: boolean;
};
export type Bbox = { w: number; s: number; e: number; n: number };

// Normalize a longitude into [-180, 180] (Leaflet hands back wrapped values when
// the world map is panned across copies).
const normLon = (lon: number) => (((lon + 180) % 360) + 360) % 360 - 180;

export default function MapView({
  points,
  truncated = false,
  loading = false,
  readOnly = false,
  onPickArea,
  onRejectArea,
  onExportArea,
  onShowInGrid,
  onOpenAsset,
}: {
  points: GeoPoint[];
  truncated?: boolean;
  loading?: boolean;
  readOnly?: boolean;
  onPickArea: (ids: number[]) => void;
  onRejectArea: (ids: number[]) => void;
  onExportArea: (ids: number[]) => void;
  onShowInGrid: (bbox: Bbox, ids: number[]) => void;
  /** Show one media full size (from the marker popover). */
  onOpenAsset: (id: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const groupRef = useRef<L.LayerGroup | null>(null);
  const rectRef = useRef<L.Rectangle | null>(null);
  const popupRef = useRef<L.Popup | null>(null);
  // Latest points, read by the (stable) selection handlers without re-binding.
  const pointsRef = useRef<GeoPoint[]>(points);
  pointsRef.current = points;

  const [drawing, setDrawing] = useState(false);
  const [area, setArea] = useState<{ bbox: Bbox; ids: number[] } | null>(null);
  // The point whose popover is open, and the popup's own DOM node (the React
  // portal target). Both null when no marker is open.
  const [active, setActive] = useState<GeoPoint | null>(null);
  const [popHost, setPopHost] = useState<HTMLDivElement | null>(null);
  // Read by the marker click handler, which is bound per redraw and must not go
  // stale on the drawing toggle.
  const drawingRef = useRef(drawing);
  drawingRef.current = drawing;

  // Which point ids fall inside a bounds (longitude wrap aware).
  const idsInBounds = useCallback((b: L.LatLngBounds): { bbox: Bbox; ids: number[] } => {
    const s = b.getSouth();
    const n = b.getNorth();
    const w = normLon(b.getWest());
    const e = normLon(b.getEast());
    const inLon = (lon: number) => (w <= e ? lon >= w && lon <= e : lon >= w || lon <= e);
    const ids = pointsRef.current
      .filter((p) => p.lat >= s && p.lat <= n && inLon(p.lon))
      .map((p) => p.id);
    return { bbox: { w, s, e, n }, ids };
  }, []);

  const clearArea = useCallback(() => {
    rectRef.current?.remove();
    rectRef.current = null;
    setArea(null);
  }, []);

  const setRect = useCallback((b: L.LatLngBounds) => {
    const map = mapRef.current;
    if (!map) return;
    if (rectRef.current) rectRef.current.setBounds(b);
    else
      rectRef.current = L.rectangle(b, {
        color: "#3aa99a",
        weight: 1.5,
        fillColor: "#3aa99a",
        fillOpacity: 0.12,
      }).addTo(map);
  }, []);

  // Use whatever is currently visible as the zone.
  const selectVisible = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const b = map.getBounds();
    setRect(b);
    setArea(idsInBounds(b));
  }, [idsInBounds, setRect]);

  // --- Init the map once ---------------------------------------------------
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, {
      worldCopyJump: true,
      // Default zoom control is replaced by our own overlay (see `.map-zoom`),
      // styled like the toolbar buttons and parked in the clear top-right corner.
      zoomControl: false,
    }).setView([20, 0], 2);
    L.tileLayer(TILE_URL, {
      attribution: TILE_ATTRIBUTION,
      maxZoom: 19,
    }).addTo(map);
    groupRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    // The single reusable marker popover. Its content is an empty node React
    // portals into (see `popHost`), and it is auto-panned clear of the floating
    // toolbar/zoom cards so a marker near the top edge stays readable.
    const host = document.createElement("div");
    // Leaflet decides whether a click was "on the map" by walking up from the
    // event's target to see if it came out of a popup — and React may already
    // have swapped that node out (starting playback replaces the thumbnail
    // <button> with a <video>), which leaves the walk starting from a detached
    // node, failing, and the map closing the popup mid-interaction. Stopping the
    // click at the popover's own root, natively, keeps the card's clicks the
    // card's business whatever React does to the DOM underneath.
    host.addEventListener("click", (e) => e.stopPropagation());
    const popup = L.popup({
      className: "map-pop-wrap",
      minWidth: 208,
      maxWidth: 240,
      closeButton: true,
      autoPanPadding: [16, 64],
    }).setContent(host);
    popupRef.current = popup;
    setPopHost(host);
    // Closing from the popup's own ✕ (or a click on the map) has to unmount the
    // React content too, or a playing video would keep running unseen.
    map.on("popupclose", (e: L.PopupEvent) => {
      if (e.popup === popup) setActive(null);
    });

    // The container is created already sized, but a tab/toggle switch can leave
    // Leaflet with a stale size — recompute on resize.
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      groupRef.current = null;
      rectRef.current = null;
      popupRef.current = null;
      setPopHost(null);
      setActive(null);
    };
  }, []);

  // --- (Re)draw the markers when the points change -------------------------
  useEffect(() => {
    const map = mapRef.current;
    const group = groupRef.current;
    if (!map || !group) return;
    group.clearLayers();
    const latlngs: L.LatLngExpression[] = [];
    for (const p of points) {
      const m = L.circleMarker([p.lat, p.lon], {
        radius: 5,
        weight: 1,
        color: "#04140f",
        fillColor: "#3aa99a",
        fillOpacity: 0.85,
      });
      // Opening the preview is a click on the dot — except while a box is being
      // drawn, where every gesture belongs to the zone.
      m.on("click", () => {
        if (!drawingRef.current) setActive(p);
      });
      group.addLayer(m);
      latlngs.push([p.lat, p.lon]);
    }
    // Frame the data on first/changed load, but don't fight the user mid-zone.
    if (latlngs.length && !area) {
      try {
        map.fitBounds(L.latLngBounds(latlngs).pad(0.15), { maxZoom: 14 });
      } catch {
        /* single point / degenerate bounds */
      }
    }
    // `area` intentionally omitted: we only want to refit on data change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points]);

  // --- Marker popover ------------------------------------------------------
  // Move/open the one popup to follow the active point (and close it when the
  // point is cleared). `openOn` is a no-op reposition when it's already open, so
  // hopping marker to marker never fires a spurious close.
  useEffect(() => {
    const map = mapRef.current;
    const popup = popupRef.current;
    if (!map || !popup) return;
    if (!active) {
      if (map.hasLayer(popup)) map.closePopup(popup);
      return;
    }
    popup.setLatLng([active.lat, active.lon]);
    if (!map.hasLayer(popup)) popup.openOn(map);
  }, [active, popHost]);

  // A filter change can drop the media the popover is describing — don't leave a
  // card floating over a dot that is no longer plotted.
  useEffect(() => {
    setActive((cur) => (cur && !points.some((p) => p.id === cur.id) ? null : cur));
  }, [points]);

  // Drawing a box owns the whole canvas: fold the popover away as it starts.
  useEffect(() => {
    if (drawing) setActive(null);
  }, [drawing]);

  // --- Draw-a-box mode -----------------------------------------------------
  // Bound with native Pointer events on the map container rather than Leaflet's
  // synthetic `mousedown`/`mousemove`/`mouseup` — those don't fire for touch, so
  // dragging a box never worked on phones/tablets. Pointer events cover mouse,
  // touch and pen uniformly; pointer capture keeps the drag alive even if the
  // finger strays off a marker, and `touch-action: none` (set in CSS while
  // drawing) stops the browser from hijacking the gesture as a scroll/pan.
  useEffect(() => {
    const map = mapRef.current;
    const el = containerRef.current;
    if (!map || !el) return;
    if (!drawing) {
      map.dragging.enable();
      return;
    }
    map.dragging.disable();
    let start: L.LatLng | null = null;
    let activeId: number | null = null;
    const toLatLng = (ev: PointerEvent) =>
      map.containerPointToLatLng(
        map.mouseEventToContainerPoint(ev as unknown as MouseEvent),
      );
    const onDown = (ev: PointerEvent) => {
      // Only the primary button / first contact starts a box.
      if (start !== null || (ev.pointerType === "mouse" && ev.button !== 0)) return;
      activeId = ev.pointerId;
      el.setPointerCapture?.(ev.pointerId);
      start = toLatLng(ev);
      clearArea();
      ev.preventDefault();
    };
    const onMove = (ev: PointerEvent) => {
      if (!start || ev.pointerId !== activeId) return;
      setRect(L.latLngBounds(start, toLatLng(ev)));
      ev.preventDefault();
    };
    const onUp = (ev: PointerEvent) => {
      if (!start || ev.pointerId !== activeId) return;
      const b = L.latLngBounds(start, toLatLng(ev));
      start = null;
      activeId = null;
      el.releasePointerCapture?.(ev.pointerId);
      setArea(idsInBounds(b));
      setDrawing(false);
      ev.preventDefault();
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
    };
  }, [drawing, clearArea, idsInBounds, setRect]);

  const count = area?.ids.length ?? 0;

  return (
    <div className={`map-wrap${drawing ? " is-drawing" : ""}`}>
      <div ref={containerRef} className="map-canvas" />

      {/* The popover's content, rendered into the Leaflet popup. Keyed by point
          so switching markers remounts it (fresh fetch, no stale playback). */}
      {popHost &&
        active &&
        createPortal(
          <MapPopover
            key={active.id}
            id={active.id}
            video={active.video}
            // The popup is opened empty (React fills it a tick later), so
            // Leaflet's own sizing/auto-pan would measure nothing. Re-run it
            // whenever the card's shape changes — on mount, when the facts land,
            // when playback starts — so it never sits clipped by the map edge.
            onLayout={() => popupRef.current?.update()}
            onOpen={(id) => {
              // Hand over to the full-screen viewer and fold the card away —
              // leaving it open would keep a clip playing behind the overlay.
              setActive(null);
              onOpenAsset(id);
            }}
          />,
          popHost,
        )}

      <div className="map-toolbar">
        <button className="btn" onClick={selectVisible} disabled={!points.length}>
          Select visible area
        </button>
        <button
          className={`btn${drawing ? " btn-primary" : ""}`}
          onClick={() => {
            clearArea();
            setDrawing((d) => !d);
          }}
          disabled={!points.length}
          title="Drag a rectangle on the map"
        >
          {drawing ? "Drawing… (drag)" : "Draw box"}
        </button>
        <span className="map-count">
          {loading
            ? "Loading…"
            : `${points.length}${truncated ? "+" : ""} geotagged`}
        </span>
      </div>

      {/* Zoom: a segmented +/- pair styled like the toolbar buttons. */}
      <div className="map-zoom" role="group" aria-label="Zoom">
        <button
          className="btn"
          onClick={() => mapRef.current?.zoomOut()}
          aria-label="Zoom out"
          title="Zoom out"
        >
          −
        </button>
        <button
          className="btn"
          onClick={() => mapRef.current?.zoomIn()}
          aria-label="Zoom in"
          title="Zoom in"
        >
          +
        </button>
      </div>

      {area && (
        <div className="map-area-bar">
          <span className="map-area-count">
            <strong>{count}</strong> in zone
          </span>
          {/* Same segmented-control language as the session action bar — icons
              carry the meaning and the labels collapse to icon-only on phones,
              keeping every action on one tappable line. */}
          <div className="seg-actions" role="group" aria-label="Zone actions">
            {!readOnly && (
              <>
                <button
                  className="seg-btn is-pick"
                  disabled={!count}
                  onClick={() => onPickArea(area.ids)}
                  aria-label="Pick media in zone"
                  title="Pick every media inside the zone"
                >
                  {Icons.keep}
                  <span className="seg-label">Pick</span>
                </button>
                <button
                  className="seg-btn is-reject"
                  disabled={!count}
                  onClick={() => onRejectArea(area.ids)}
                  aria-label="Reject media in zone"
                  title="Reject every media inside the zone"
                >
                  {Icons.skip}
                  <span className="seg-label">Reject</span>
                </button>
                <button
                  className="seg-btn"
                  disabled={!count}
                  onClick={() => onExportArea(area.ids)}
                  aria-label="Export media in zone"
                  title="Export the media inside the zone"
                >
                  {Icons.upload}
                  <span className="seg-label">Export</span>
                </button>
              </>
            )}
            <button
              className="seg-btn"
              disabled={!count}
              onClick={() => onShowInGrid(area.bbox, area.ids)}
              aria-label="Show zone in grid"
              title="Show the zone's media in the grid"
            >
              {Icons.viewCard}
              <span className="seg-label">Grid</span>
            </button>
            <button
              className="seg-btn"
              onClick={clearArea}
              aria-label="Clear zone"
              title="Clear the zone"
            >
              {Icons.close}
              <span className="seg-label">Clear</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
