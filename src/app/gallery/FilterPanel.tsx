"use client";

import { useEffect, useRef, useState } from "react";
import { friendlyCameraName } from "@/lib/cameraLabels";
import { Icons } from "../ui";

export type Facets = {
  total: number;
  ranges: {
    size_min?: number | null;
    size_max?: number | null;
    iso_min?: number | null;
    iso_max?: number | null;
    focal_min?: number | null;
    focal_max?: number | null;
    aperture_min?: number | null;
    aperture_max?: number | null;
  };
  years: VC[];
  months: VC[];
  days: VC[];
  devices: VC[];
  camera_models: VC[];
  lenses: VC[];
  // Reverse-geocoded place facets (cf. lib/geocode.ts). Optional so a facets
  // payload predating the feature still typechecks.
  place_countries?: VC[];
  place_regions?: VC[];
  place_counties?: VC[];
  place_cities?: VC[];
  place_pois?: VC[];
  // ML analysis facets (cf. lib/ml.ts). `faces` counts assets per detected-face
  // count (0 = analyzed, nobody in frame); `with_text` counts assets whose OCR
  // read some text. Optional so a facets payload predating the feature typechecks.
  faces?: VC[];
  with_text?: number;
  extensions: VC[];
  media_types: VC[];
  derivative_statuses: VC[];
  tags: VC[];
  // iPhone Live Photos available in scope (still primaries, one per pair). Drives
  // the "Live Photos" filter toggle. Cf. lib/pairing.ts.
  live_photos?: number;
  // Session-level counts for the Sessions grid's status toggles.
  session_status?: { active: number; ignored: number };
};
type VC = { value: string | number; count: number };

// Friendly labels for the technical derivative lifecycle states.
const DERIVATIVE_LABELS: Record<string, string> = {
  pending: "Pending",
  processing: "Processing",
  ready: "Ready",
  error: "Error",
  skipped: "Skipped",
};

export type Filters = {
  // Free-text search over the file path (folder + filename) — the `q=` param.
  q?: string;
  media_type: string[];
  ext: string[];
  // Derivative lifecycle filter. Exactly one side is ever populated: the panel's
  // Include/Exclude toggle decides whether the picked statuses are kept
  // (derivative_status, IN) or hidden (not_derivative_status, NOT IN).
  derivative_status: string[];
  not_derivative_status: string[];
  device: string[];
  camera_model: string[];
  lens: string[];
  // Reverse-geocoded place (cf. lib/geocode.ts): filter by where a photo was taken.
  place_country: string[];
  place_region: string[];
  place_county: string[];
  place_city: string[];
  place_poi: string[];
  // ML analysis (cf. lib/ml.ts): exact detected-face counts (multi) + the
  // boolean shortcuts (at least one face / OCR text present).
  face_count: number[];
  has_faces?: boolean;
  has_text?: boolean;
  tags: string[];
  year: number[];
  month: number[];
  day: number[];
  // Driven by the tree (drill-down):
  root_id?: number;
  session_id?: number;
  date_from?: string;
  date_to?: string;
  verdict?: "pick" | "reject" | "unrated";
  star_min?: number;
  iso_min?: number;
  iso_max?: number;
  focal_min?: number;
  focal_max?: number;
  aperture_min?: number;
  aperture_max?: number;
  size_min?: number; // MB (UI) — converted to bytes in the query
  size_max?: number;
  // Sharpness (variance of the Laplacian, cf. lib/ml.ts): low = blurry.
  sharpness_min?: number;
  sharpness_max?: number;
  has_gps?: boolean;
  // Pairing: narrow to one kind of pair. The "Live Photos" toggle sets
  // `group_kind="live_photo"` (cf. lib/pairing.ts).
  group_kind?: "raw_jpeg" | "live_photo";
  // Finals → sources reconciliation (cf. lib/reconcile.ts). `has_edit` → sources
  // that have a linked edit; `is_edit` → finals linked back to a source.
  has_edit?: boolean;
  is_edit?: boolean;
  // Session grid only: ignored sessions are hidden until opted in. (Done is the
  // progress toolbar's job, not a hidden flag.)
  show_ignored?: boolean;
  // Map zone: [west, south, east, north]. Set by the map view, applied as a
  // cumulative filter to the grid and to bulk actions.
  bbox?: [number, number, number, number];
};

export const EMPTY_FILTERS: Filters = {
  media_type: [],
  ext: [],
  derivative_status: [],
  not_derivative_status: [],
  device: [],
  camera_model: [],
  lens: [],
  place_country: [],
  place_region: [],
  place_county: [],
  place_city: [],
  place_poi: [],
  face_count: [],
  tags: [],
  year: [],
  month: [],
  day: [],
};

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function toggle<T>(arr: T[], v: T): T[] {
  return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
}

// Free-text search over the filename / folder. Local state keeps the field
// responsive while a debounce defers the actual filter change (and the refetch
// it triggers) until typing pauses. `value` flows back in on external resets
// (Reset button, deep link), so the field stays in sync without a refetch loop.
function SearchBox({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [text, setText] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setText(value), [value]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const commit = (v: string) => {
    setText(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => onChange(v), 300);
  };

  return (
    <div className="facet">
      <div className="facet-title">Search</div>
      <div className="search-field">
        <span className="search-icon" aria-hidden>
          {Icons.search}
        </span>
        <input
          className="input search-input"
          type="search"
          placeholder="Filename or folder…"
          value={text}
          onChange={(e) => commit(e.target.value)}
        />
        {text && (
          <button
            className="search-clear"
            onClick={() => commit("")}
            aria-label="Clear search"
            title="Clear search"
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
}

function Chips<T extends string | number>({
  title,
  options,
  selected,
  onToggle,
  label,
}: {
  title: string;
  options: VC[];
  selected: T[];
  onToggle: (v: T) => void;
  label?: (v: string | number) => string;
}) {
  if (!options || options.length === 0) return null;
  return (
    <div className="facet">
      <div className="facet-title">{title}</div>
      <div className="chips">
        {options.map((o) => {
          const active = selected.includes(o.value as T);
          return (
            <button
              key={String(o.value)}
              className={`chip${active ? " active" : ""}`}
              onClick={() => onToggle(o.value as T)}
            >
              {label ? label(o.value) : o.value}
              <span className="chip-count">{o.count}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Derivative-status facet with an Include/Exclude mode toggle. The same chip
// row drives two opposite filters: in "Include only" mode the picked statuses
// become `derivative_status` (show only these); in "Exclude" mode they become
// `not_derivative_status` (hide these). Only one side is ever populated, so
// flipping the toggle simply re-reads the current picks the other way.
function DerivativeFacet({
  options,
  include,
  exclude,
  onChange,
}: {
  options: VC[];
  include: string[];
  exclude: string[];
  onChange: (next: { include: string[]; exclude: string[] }) => void;
}) {
  const [mode, setMode] = useState<"include" | "exclude">(
    exclude.length ? "exclude" : "include",
  );

  // Keep the toggle honest when filters change from outside (deep link / Reset):
  // a populated side wins; with both empty we leave the user's chosen mode.
  useEffect(() => {
    if (exclude.length) setMode("exclude");
    else if (include.length) setMode("include");
  }, [include.length, exclude.length]);

  if (!options || options.length === 0) return null;

  const selected = mode === "exclude" ? exclude : include;
  const emit = (next: string[]) =>
    onChange(
      mode === "exclude"
        ? { include: [], exclude: next }
        : { include: next, exclude: [] },
    );

  const switchMode = (next: "include" | "exclude") => {
    if (next === mode) return;
    setMode(next);
    // Carry the current picks across so "show only these" ↔ "hide these".
    onChange(
      next === "exclude"
        ? { include: [], exclude: selected }
        : { include: selected, exclude: [] },
    );
  };

  return (
    <div className="facet">
      <div className="facet-head">
        <div className="facet-title">Derivative</div>
        <div className="view-toggle" role="group" aria-label="Derivative filter mode">
          {(["include", "exclude"] as const).map((m) => (
            <button
              key={m}
              className={`view-btn${mode === m ? " active" : ""}`}
              onClick={() => switchMode(m)}
              aria-pressed={mode === m}
            >
              {m === "include" ? "Include only" : "Exclude"}
            </button>
          ))}
        </div>
      </div>
      <div className="chips">
        {options.map((o) => {
          const value = String(o.value);
          const active = selected.includes(value);
          return (
            <button
              key={value}
              className={`chip${active ? (mode === "exclude" ? " active exclude" : " active") : ""}`}
              onClick={() => emit(toggle(selected, value))}
            >
              {mode === "exclude" && active ? "✕ " : ""}
              {DERIVATIVE_LABELS[value] ?? value}
              <span className="chip-count">{o.count}</span>
            </button>
          );
        })}
      </div>
      <div className="hint" style={{ marginTop: 4 }}>
        {mode === "exclude"
          ? "Hides assets with the selected statuses."
          : "Shows only assets with the selected statuses."}
      </div>
    </div>
  );
}

function Range({
  title,
  unit,
  min,
  max,
  onMin,
  onMax,
}: {
  title: string;
  unit?: string;
  min?: number;
  max?: number;
  onMin: (v?: number) => void;
  onMax: (v?: number) => void;
}) {
  const parse = (s: string) => (s === "" ? undefined : Number(s));
  return (
    <div className="facet">
      <div className="facet-title">{title}{unit ? ` (${unit})` : ""}</div>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          className="input"
          style={{ width: "50%" }}
          type="number"
          placeholder="min"
          value={min ?? ""}
          onChange={(e) => onMin(parse(e.target.value))}
        />
        <input
          className="input"
          style={{ width: "50%" }}
          type="number"
          placeholder="max"
          value={max ?? ""}
          onChange={(e) => onMax(parse(e.target.value))}
        />
      </div>
    </div>
  );
}

export default function FilterPanel({
  facets,
  filters,
  set,
  showSessionStatus = false,
}: {
  facets: Facets | null;
  filters: Filters;
  set: (f: Filters) => void;
  /** Show the Sessions-only status toggle (ignored). */
  showSessionStatus?: boolean;
}) {
  if (!facets) return <div className="spinner">Loading filters…</div>;
  const u = (patch: Partial<Filters>) => set({ ...filters, ...patch });
  const status = facets.session_status;

  return (
    <div className="filter-panel">
      <SearchBox
        value={filters.q ?? ""}
        onChange={(v) => u({ q: v.trim() ? v : undefined })}
      />

      {showSessionStatus && status && (
        <div className="facet">
          <div className="facet-title">Session status</div>
          <div className="chips">
            <button
              className={`chip${filters.show_ignored ? " active" : ""}`}
              onClick={() =>
                u({ show_ignored: filters.show_ignored ? undefined : true })
              }
            >
              Ignored<span className="chip-count">{status.ignored}</span>
            </button>
          </div>
          <div className="hint" style={{ marginTop: 4 }}>
            Ignored sessions are hidden until selected.
          </div>
        </div>
      )}

      <div className="facet">
        <div className="facet-title">Verdict</div>
        <div className="chips">
          {(["pick", "reject", "unrated"] as const).map((v) => (
            <button
              key={v}
              className={`chip${filters.verdict === v ? " active" : ""}`}
              onClick={() => u({ verdict: filters.verdict === v ? undefined : v })}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      <div className="facet">
        <div className="facet-title">Min stars</div>
        <div className="chips">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              className={`chip${filters.star_min === n ? " active" : ""}`}
              onClick={() => u({ star_min: filters.star_min === n ? undefined : n })}
            >
              {"★".repeat(n)}
            </button>
          ))}
        </div>
      </div>

      <Chips
        title="Tags"
        options={facets.tags}
        selected={filters.tags}
        onToggle={(v) => u({ tags: toggle(filters.tags, String(v)) })}
      />
      <Chips
        title="Type"
        options={facets.media_types}
        selected={filters.media_type}
        onToggle={(v) => u({ media_type: toggle(filters.media_type, String(v)) })}
      />
      <Chips
        title="Extension"
        options={facets.extensions}
        selected={filters.ext}
        onToggle={(v) => u({ ext: toggle(filters.ext, String(v)) })}
      />
      <DerivativeFacet
        options={facets.derivative_statuses}
        include={filters.derivative_status}
        exclude={filters.not_derivative_status}
        onChange={({ include, exclude }) =>
          u({ derivative_status: include, not_derivative_status: exclude })
        }
      />
      <Chips
        title="Device"
        options={facets.devices}
        selected={filters.device}
        onToggle={(v) => u({ device: toggle(filters.device, String(v)) })}
        label={(v) => friendlyCameraName(String(v))}
      />
      <Chips
        title="Camera"
        options={facets.camera_models}
        selected={filters.camera_model}
        onToggle={(v) => u({ camera_model: toggle(filters.camera_model, String(v)) })}
        label={(v) => friendlyCameraName(String(v))}
      />
      <Chips
        title="Lens"
        options={facets.lenses}
        selected={filters.lens}
        onToggle={(v) => u({ lens: toggle(filters.lens, String(v)) })}
      />

      {/* Reverse-geocoded location (cf. lib/geocode.ts). Country → POI, coarse to
          fine. Each list is only shown when the facet has values in scope. */}
      <Chips
        title="Country"
        options={facets.place_countries ?? []}
        selected={filters.place_country}
        onToggle={(v) => u({ place_country: toggle(filters.place_country, String(v)) })}
      />
      <Chips
        title="Region"
        options={facets.place_regions ?? []}
        selected={filters.place_region}
        onToggle={(v) => u({ place_region: toggle(filters.place_region, String(v)) })}
      />
      <Chips
        title="Department"
        options={facets.place_counties ?? []}
        selected={filters.place_county}
        onToggle={(v) => u({ place_county: toggle(filters.place_county, String(v)) })}
      />
      <Chips
        title="City"
        options={facets.place_cities ?? []}
        selected={filters.place_city}
        onToggle={(v) => u({ place_city: toggle(filters.place_city, String(v)) })}
      />
      <Chips
        title="Place"
        options={facets.place_pois ?? []}
        selected={filters.place_poi}
        onToggle={(v) => u({ place_poi: toggle(filters.place_poi, String(v)) })}
      />

      {/* ML analysis (cf. lib/ml.ts): filter by the people in frame + the text
          read in the image. Only shown once some assets have been analyzed. */}
      {!!facets.faces?.length && (
        <div className="facet">
          <div className="facet-title">Faces</div>
          <div className="chips">
            <button
              className={`chip${filters.has_faces === true ? " active" : ""}`}
              onClick={() =>
                u({ has_faces: filters.has_faces === true ? undefined : true, face_count: [] })
              }
              title="Media with at least one detected face"
            >
              Has faces
            </button>
            <button
              className={`chip${filters.has_faces === false ? " active" : ""}`}
              onClick={() =>
                u({ has_faces: filters.has_faces === false ? undefined : false, face_count: [] })
              }
              title="Media with no detected face"
            >
              No faces
            </button>
            {facets.faces
              .filter((o) => Number(o.value) > 0)
              .map((o) => {
                const n = Number(o.value);
                const active = filters.face_count.includes(n);
                return (
                  <button
                    key={n}
                    className={`chip${active ? " active" : ""}`}
                    onClick={() =>
                      u({ face_count: toggle(filters.face_count, n), has_faces: undefined })
                    }
                  >
                    {n === 1 ? "1 face" : `${n} faces`}
                    <span className="chip-count">{o.count}</span>
                  </button>
                );
              })}
          </div>
        </div>
      )}
      {!!facets.with_text && (
        <div className="facet">
          <label
            className="hint"
            style={{ display: "flex", gap: 8, alignItems: "center" }}
          >
            <input
              type="checkbox"
              checked={!!filters.has_text}
              onChange={(e) => u({ has_text: e.target.checked || undefined })}
            />
            Has text (OCR)
            <span className="chip-count">{facets.with_text}</span>
          </label>
        </div>
      )}

      <Chips
        title="Year"
        options={facets.years}
        selected={filters.year}
        onToggle={(v) => u({ year: toggle(filters.year, Number(v)) })}
      />
      <Chips
        title="Month"
        options={facets.months}
        selected={filters.month}
        onToggle={(v) => u({ month: toggle(filters.month, Number(v)) })}
        label={(v) => MONTHS[Number(v) - 1] ?? String(v)}
      />
      <Chips
        title="Day"
        options={facets.days}
        selected={filters.day}
        onToggle={(v) => u({ day: toggle(filters.day, Number(v)) })}
      />

      <div className="facet">
        <div className="facet-title">Date range</div>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            className="input"
            style={{ width: "50%" }}
            type="date"
            value={filters.date_from ?? ""}
            onChange={(e) => u({ date_from: e.target.value || undefined })}
          />
          <input
            className="input"
            style={{ width: "50%" }}
            type="date"
            value={filters.date_to ?? ""}
            onChange={(e) => u({ date_to: e.target.value || undefined })}
          />
        </div>
      </div>

      <Range
        title="ISO"
        min={filters.iso_min}
        max={filters.iso_max}
        onMin={(v) => u({ iso_min: v })}
        onMax={(v) => u({ iso_max: v })}
      />
      <Range
        title="Focal"
        unit="mm"
        min={filters.focal_min}
        max={filters.focal_max}
        onMin={(v) => u({ focal_min: v })}
        onMax={(v) => u({ focal_max: v })}
      />
      <Range
        title="Aperture"
        unit="f/"
        min={filters.aperture_min}
        max={filters.aperture_max}
        onMin={(v) => u({ aperture_min: v })}
        onMax={(v) => u({ aperture_max: v })}
      />
      <Range
        title="Size"
        unit="MB"
        min={filters.size_min}
        max={filters.size_max}
        onMin={(v) => u({ size_min: v })}
        onMax={(v) => u({ size_max: v })}
      />
      <div>
        <Range
          title="Sharpness"
          min={filters.sharpness_min}
          max={filters.sharpness_max}
          onMin={(v) => u({ sharpness_min: v })}
          onMax={(v) => u({ sharpness_max: v })}
        />
        <div className="hint" style={{ marginTop: -4 }}>
          Low = blurry. Set only a max to surface the soft shots; the score
          shows in the viewer’s info panel.
        </div>
      </div>

      <div className="facet">
        <label className="hint" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="checkbox"
            checked={!!filters.has_gps}
            onChange={(e) => u({ has_gps: e.target.checked || undefined })}
          />
          Has GPS
        </label>
      </div>

      <div className="facet">
        <div className="facet-title">Edits (before / after)</div>
        <div className="chips">
          <button
            className={`chip${filters.has_edit ? " active" : ""}`}
            onClick={() =>
              u({ has_edit: filters.has_edit ? undefined : true })
            }
            title="Source captures that have a linked edit"
          >
            Has edit
          </button>
          <button
            className={`chip${filters.is_edit ? " active" : ""}`}
            onClick={() => u({ is_edit: filters.is_edit ? undefined : true })}
            title="Edited finals linked back to a source"
          >
            Is an edit
          </button>
        </div>
        <div className="hint" style={{ marginTop: 4 }}>
          Links edited finals to the source they came from.
        </div>
      </div>

      {!!facets.live_photos && (
        <div className="facet">
          <label
            className="hint"
            style={{ display: "flex", gap: 8, alignItems: "center" }}
          >
            <input
              type="checkbox"
              checked={filters.group_kind === "live_photo"}
              onChange={(e) =>
                u({ group_kind: e.target.checked ? "live_photo" : undefined })
              }
            />
            Live Photos
            <span className="chip-count">{facets.live_photos}</span>
          </label>
        </div>
      )}
    </div>
  );
}
