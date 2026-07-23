"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { searchPlaces, type PlaceSuggestion } from "@/lib/assetActions";
import { TILE_URL, TILE_ATTRIBUTION } from "@/app/mapTiles";

// Step 1 of the manual geotag flow (cf. GeotagRecapModal for step 2): choose
// the capture location. Three converging inputs, all driving one marker:
//   - type a place name → autocomplete over the configured geocode provider
//     (GET /api/places/search) → picking a suggestion drops/moves the marker;
//   - click the map (or drag the marker) to point at the exact spot;
//   - edit the lat/lon fields directly for a known coordinate.
// "Continue" hands the chosen point to the caller, which opens the recap.

export type PickedLocation = { lat: number; lon: number; label: string | null };

// Round for display/storage: ~1e-6° ≈ 0.11 m, plenty for a capture location
// and keeps hand-picked values from carrying 15 meaningless decimals.
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

export default function LocationPickerModal({
  count,
  initial,
  onClose,
  onPicked,
}: {
  /** How many assets are being geotagged (title only). */
  count: number;
  /** Seed position (e.g. the asset's current GPS when re-tagging). */
  initial?: { lat: number; lon: number } | null;
  onClose: () => void;
  /** Called with the confirmed point; the caller opens the recap modal. */
  onPicked: (loc: PickedLocation) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);

  const [pos, setPos] = useState<{ lat: number; lon: number } | null>(
    initial ?? null,
  );
  // The human-readable name of the last suggestion applied; cleared when the
  // point is then moved by hand (the name would no longer describe it).
  const [label, setLabel] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [openList, setOpenList] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Place (or move) the marker; optionally recenter the view on it.
  const setMarker = useCallback(
    (lat: number, lon: number, opts: { fly?: boolean; zoom?: number } = {}) => {
      const map = mapRef.current;
      if (!map) return;
      if (markerRef.current) markerRef.current.setLatLng([lat, lon]);
      else {
        // A CSS pin (divIcon) rather than Leaflet's default image marker: the
        // bundler doesn't ship leaflet's dist/images, and a divIcon inherits
        // the app's theme for free.
        const m = L.marker([lat, lon], {
          draggable: true,
          icon: L.divIcon({
            className: "picker-pin-wrap",
            html: '<span class="picker-pin"></span>',
            iconSize: [24, 24],
            iconAnchor: [12, 22],
          }),
        }).addTo(map);
        m.on("dragend", () => {
          const p = m.getLatLng();
          setPos({ lat: round6(p.lat), lon: round6(p.lng) });
          setLabel(null);
        });
        markerRef.current = m;
      }
      if (opts.fly)
        map.flyTo([lat, lon], opts.zoom ?? Math.max(map.getZoom(), 13), {
          duration: 0.6,
        });
    },
    [],
  );

  // --- Init the map once ---------------------------------------------------
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, { zoomControl: true });
    if (initial) map.setView([initial.lat, initial.lon], 13);
    else map.setView([20, 0], 2);
    L.tileLayer(TILE_URL, { attribution: TILE_ATTRIBUTION, maxZoom: 19 }).addTo(
      map,
    );
    map.on("click", (e: L.LeafletMouseEvent) => {
      const lat = round6(e.latlng.lat);
      const lon = round6(((e.latlng.lng + 180) % 360 + 360) % 360 - 180);
      setPos({ lat, lon });
      setLabel(null);
      setMarker(lat, lon);
    });
    mapRef.current = map;
    // The modal animates in: sizes settle a tick after mount.
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(containerRef.current);
    if (initial) setMarker(initial.lat, initial.lon);
    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
    // Init-once: `initial` is only a seed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Autocomplete: debounced search over /api/places/search --------------
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 3) {
      setSuggestions([]);
      setOpenList(false);
      setSearchError(null);
      return;
    }
    let alive = true;
    setSearching(true);
    const t = setTimeout(() => {
      searchPlaces(trimmed)
        .then((results) => {
          if (!alive) return;
          setSuggestions(results);
          setOpenList(true);
          setActiveIdx(results.length ? 0 : -1);
          setSearchError(
            results.length ? null : "No place found for that name.",
          );
        })
        .catch((e) => {
          if (!alive) return;
          setSuggestions([]);
          setSearchError((e as Error).message);
        })
        .finally(() => alive && setSearching(false));
    }, 350);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [query]);

  const applySuggestion = useCallback(
    (s: PlaceSuggestion) => {
      const lat = round6(s.lat);
      const lon = round6(s.lon);
      setPos({ lat, lon });
      setLabel(s.display_name);
      setQuery(s.display_name);
      setOpenList(false);
      setMarker(lat, lon, { fly: true });
    },
    [setMarker],
  );

  // Manual lat/lon edit (typed coordinate). Applied on change when parseable.
  const editCoord = useCallback(
    (axis: "lat" | "lon", raw: string) => {
      const v = Number.parseFloat(raw);
      if (!Number.isFinite(v)) return;
      const clamped =
        axis === "lat" ? Math.max(-90, Math.min(90, v)) : Math.max(-180, Math.min(180, v));
      setPos((prev) => {
        const next = {
          lat: axis === "lat" ? clamped : prev?.lat ?? 0,
          lon: axis === "lon" ? clamped : prev?.lon ?? 0,
        };
        setMarker(next.lat, next.lon, { fly: true });
        return next;
      });
      setLabel(null);
    },
    [setMarker],
  );

  // Close on Escape (the dropdown first, then the modal).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (openList) setOpenList(false);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openList, onClose]);

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!openList || !suggestions.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => (i + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => (i - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === "Enter" && activeIdx >= 0) {
      e.preventDefault();
      applySuggestion(suggestions[activeIdx]);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div
        className="modal modal-wide"
        role="dialog"
        aria-modal="true"
        aria-label="Choose a location"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title">
          Geotag {count} {count === 1 ? "media" : "medias"}
        </h2>
        <p className="hint" style={{ marginTop: 0 }}>
          Search a place, click the map or drag the marker to the capture
          location.
        </p>

        <label className="modal-label" htmlFor="geotag-place">
          Place
        </label>
        <div className="place-search">
          <input
            id="geotag-place"
            className="input"
            type="text"
            placeholder="e.g. Château de Chambord, Reykjavík, …"
            value={query}
            autoFocus
            autoComplete="off"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKeyDown}
            onFocus={() => suggestions.length && setOpenList(true)}
          />
          {searching && <span className="place-search-spin hint">…</span>}
          {openList && suggestions.length > 0 && (
            <ul className="place-suggestions" role="listbox">
              {suggestions.map((s, i) => (
                <li key={`${s.lat},${s.lon},${i}`} role="presentation">
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === activeIdx}
                    className={`place-suggestion${i === activeIdx ? " active" : ""}`}
                    onMouseEnter={() => setActiveIdx(i)}
                    onClick={() => applySuggestion(s)}
                  >
                    {s.display_name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {searchError && !searching && (
          <p className="hint" style={{ marginTop: 4 }}>
            {searchError}
          </p>
        )}

        <div className="picker-map" ref={containerRef} />

        <div className="picker-coords">
          <label>
            <span className="modal-label" style={{ marginTop: 0 }}>
              Latitude
            </span>
            <input
              className="input"
              type="number"
              step="0.000001"
              min={-90}
              max={90}
              value={pos ? String(pos.lat) : ""}
              placeholder="—"
              onChange={(e) => editCoord("lat", e.target.value)}
            />
          </label>
          <label>
            <span className="modal-label" style={{ marginTop: 0 }}>
              Longitude
            </span>
            <input
              className="input"
              type="number"
              step="0.000001"
              min={-180}
              max={180}
              value={pos ? String(pos.lon) : ""}
              placeholder="—"
              onChange={(e) => editCoord("lon", e.target.value)}
            />
          </label>
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!pos}
            onClick={() => pos && onPicked({ ...pos, label })}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
