"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { searchPlaces, type PlaceSuggestion } from "@/lib/assetActions";
import { TILE_URL, TILE_ATTRIBUTION } from "@/app/mapTiles";

// The "where was this shot" control: one marker driven by three converging
// inputs — a place-name autocomplete over the configured geocode provider
// (GET /api/places/search), a click or drag on the map, and the lat/lon fields.
//
// It is a plain controlled control, not a dialog, because TWO dialogs need it
// and a second copy would drift: `LocationPickerModal` (step 1 of the manual
// geotag flow, where choosing the point IS the dialog) and `GeotagRecapModal`
// (where the point arrives pre-filled and the map is what makes it legible —
// "43.5600, 3.9000" says nothing, a coastline says Pérols). Leaflet touches
// `window` on import, so every host loads this through `next/dynamic`.
//
// Controlled on the POSITION only: the query, the suggestion list and the map
// viewport are its own business. Each change emits the full PickedLocation,
// label included — the place name when it came from a suggestion, null once
// the pin is moved by hand, because the name no longer describes the point.

export type PickedLocation = { lat: number; lon: number; label: string | null };

// Round for display/storage: ~1e-6° ≈ 0.11 m, plenty for a capture location
// and keeps hand-picked values from carrying 15 meaningless decimals.
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

// Below this the marker is considered to be where `value` says it is, so the
// sync effect leaves the map alone (a drag must not fight its own echo).
const SAME_POINT = 1e-6;

export default function LocationPicker({
  value,
  onChange,
  layout = "stack",
  autoFocus = false,
  inputId = "location-picker-place",
}: {
  value: PickedLocation | null;
  onChange: (v: PickedLocation) => void;
  /** `stack`: search, map, coordinates in a column — a dialog whose whole job
   *  is the map. `split`: the map beside the fields, for a dialog where it is
   *  one element among others. */
  layout?: "stack" | "split";
  autoFocus?: boolean;
  inputId?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  // The seed the map opens on: captured once, so a later change moves the
  // marker (below) rather than re-creating the map.
  const initialRef = useRef(value);

  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [openList, setOpenList] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // The map's click handler is bound once, so it reads `onChange` through a
  // ref rather than capturing the first render's copy.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

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
        // Bound once with the marker, so it reports through the ref: a host
        // that passes a fresh arrow on every render (the usual case) must not
        // leave the pin reporting to the first one.
        m.on("dragend", () => {
          const p = m.getLatLng();
          onChangeRef.current({
            lat: round6(p.lat),
            lon: round6(p.lng),
            label: null,
          });
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
    const seed = initialRef.current;
    const map = L.map(containerRef.current, { zoomControl: true });
    if (seed) map.setView([seed.lat, seed.lon], 13);
    else map.setView([20, 0], 2);
    L.tileLayer(TILE_URL, { attribution: TILE_ATTRIBUTION, maxZoom: 19 }).addTo(
      map,
    );
    map.on("click", (e: L.LeafletMouseEvent) => {
      const lat = round6(e.latlng.lat);
      const lon = round6(((((e.latlng.lng + 180) % 360) + 360) % 360) - 180);
      onChangeRef.current({ lat, lon, label: null });
    });
    mapRef.current = map;
    // The host dialog animates in: sizes settle a tick after mount.
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(containerRef.current);
    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
    // Init-once on purpose; the seed and the handler are read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the marker on `value`, wherever the change came from (this control,
  // or the host handing back a different point).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !value) return;
    const at = markerRef.current?.getLatLng();
    if (
      at &&
      Math.abs(at.lat - value.lat) < SAME_POINT &&
      Math.abs(at.lng - value.lon) < SAME_POINT
    )
      return;
    // Recentre only when the new point would be off-screen, or when the first
    // pin lands on the opening world view: clicking a spot that is already
    // visible must not slide the map out from under the cursor.
    const inView = map.getBounds().contains([value.lat, value.lon]);
    setMarker(value.lat, value.lon, {
      fly: !inView || (at == null && map.getZoom() < 8),
    });
  }, [value, setMarker]);

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
          setSearchError(results.length ? null : "No place found for that name.");
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
      setQuery(s.display_name);
      setOpenList(false);
      onChange({ lat: round6(s.lat), lon: round6(s.lon), label: s.display_name });
    },
    [onChange],
  );

  // Manual lat/lon edit (typed coordinate). Applied on change when parseable.
  const editCoord = useCallback(
    (axis: "lat" | "lon", raw: string) => {
      const v = Number.parseFloat(raw);
      if (!Number.isFinite(v)) return;
      const clamped =
        axis === "lat"
          ? Math.max(-90, Math.min(90, v))
          : Math.max(-180, Math.min(180, v));
      onChange({
        lat: axis === "lat" ? clamped : (value?.lat ?? 0),
        lon: axis === "lon" ? clamped : (value?.lon ?? 0),
        label: null,
      });
    },
    [onChange, value],
  );

  // Escape closes the dropdown before the host's own dialog sees it.
  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape" && openList) {
      e.stopPropagation();
      setOpenList(false);
      return;
    }
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

  const search = (
    <>
      <label className="modal-label" htmlFor={inputId}>
        Place
      </label>
      <div className="place-search">
        <input
          id={inputId}
          className="input"
          type="text"
          placeholder="e.g. Château de Chambord, Reykjavík, …"
          value={query}
          autoFocus={autoFocus}
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
    </>
  );

  const coords = (
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
          value={value ? String(value.lat) : ""}
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
          value={value ? String(value.lon) : ""}
          placeholder="—"
          onChange={(e) => editCoord("lon", e.target.value)}
        />
      </label>
    </div>
  );

  const map = <div className="picker-map" ref={containerRef} />;

  // `stack` keeps the picker modal's own order (search, map, coordinates);
  // `split` puts the map beside the fields, which is how it fits into a dialog
  // that already has a table to show.
  return layout === "split" ? (
    <div className="picker-split">
      {map}
      <div className="picker-side">
        {search}
        {coords}
      </div>
    </div>
  ) : (
    <>
      {search}
      {map}
      {coords}
    </>
  );
}
