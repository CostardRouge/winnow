"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { friendlyCameraName } from "@/lib/cameraLabels";
import { Icons } from "../ui";
import RangeSlider from "./RangeSlider";

export type Facets = {
  total: number;
  ranges: {
    // Bytes, straight off the `file_size` column — the Size facet renders MB, so
    // the panel divides by 1 MiB (cf. `MB` below).
    size_min?: number | null;
    size_max?: number | null;
    iso_min?: number | null;
    iso_max?: number | null;
    focal_min?: number | null;
    focal_max?: number | null;
    aperture_min?: number | null;
    aperture_max?: number | null;
    // Laplacian variance (cf. lib/ml.ts). Null until ML analysis has run, so the
    // Sharpness slider degrades to its number-field pair on a fresh library.
    sharpness_min?: number | null;
    sharpness_max?: number | null;
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
  // People in scope (cf. lib/people.ts): id + name + asset count + cover face
  // (the chip's crop), named first then busiest, capped server-side. Optional
  // so a facets payload predating the feature typechecks.
  people?: PersonFacet[];
  with_text?: number;
  // How many assets carry a perceptual hash (were analyzed). Gates the
  // "Near-duplicates" toggle so it never shows as a dead filter. Optional so a
  // facets payload predating the feature typechecks.
  with_phash?: number;
  // Burst/bracket stacks in scope (cf. lib/bursts.ts): `piles` counts the
  // stacks, `frames` the shots they hold. Drives the "Bursts" filter toggle —
  // in the collapsed grid the filter yields exactly `piles` tiles (one cover
  // per burst). `action_piles`/`bracket_piles` split `piles` by Burst.kind and
  // drive the Action/Bracket sub-toggle. Optional so a facets payload
  // predating the feature typechecks.
  bursts?: {
    piles: number;
    frames: number;
    action_piles: number;
    bracket_piles: number;
  };
  // Finals → sources reconciliation (cf. lib/reconcile.ts), one count per
  // direction of the link: `linked` = finals that point at a source, with_edits`
  // = sources something points back at. Each is only ever non-zero on ONE
  // surface (a final can't have an edit; a source can't be one), so the panel
  // gates each axis on its own count and the dead half never renders. Optional
  // so a facets payload predating the feature still typechecks.
  edits?: { linked: number; with_edits: number };
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
export type PersonFacet = {
  id: number;
  name: string | null;
  // Absent on a fallback-resolved chip (a deep-linked person outside the
  // facet's cap): the chip then shows no count rather than a wrong one.
  count?: number;
  cover_face_id?: number | null;
};

// Size is the one facet whose stored unit isn't the unit on screen: the column
// (and the API's `size_min`/`size_max` params) is bytes, while the panel shows —
// and the user types — MB. Exported so GalleryShell multiplies by the very same
// divisor on the way back out; a mismatch here is what made the Size handles
// read in the tens of millions.
export const MB = 1024 * 1024;

/**
 * Bytes → MB at 2-decimal precision. `round` widens the domain outward (floor
 * for the low bound, ceil for the high) so the slider always covers the data.
 */
function toMB(
  bytes: number | null | undefined,
  round: (n: number) => number,
): number | undefined {
  return typeof bytes === "number" ? round((bytes / MB) * 100) / 100 : undefined;
}

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
  // People (cf. lib/people.ts): keep assets in which the selected people
  // appear — any of them (default) or all together (`person_mode: "all"`).
  // Person ids — labels come from the facet payload.
  person: number[];
  person_mode?: "any" | "all";
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
  // Perceptual near-duplicates (cf. lib/ml.ts): true → only frames that have a
  // look-alike in the same session. A simple toggle (the "only loners" inverse
  // isn't exposed in the panel).
  near_dup?: boolean;
  has_gps?: boolean;
  // Pairing: narrow to one kind of pair. The "Live Photos" toggle sets
  // `group_kind="live_photo"` (cf. lib/pairing.ts).
  group_kind?: "raw_jpeg" | "live_photo";
  // Burst/bracket stacks (cf. lib/bursts.ts). Tri-state: true → only frames that
  // belong to a pile, false → only the standalone shots, undefined → both.
  stacked?: boolean;
  // Narrows piles by kind (cf. Burst.kind): 'action' (continuous shooting) vs
  // 'bracket' (exposure-bracketed / AEB).
  burst_kind?: "action" | "bracket";
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
  person: [],
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

// The People facet: one chip per person, wearing their cover face crop.
// Multi-pick (ORed server-side, like every categorical dimension). Two rules
// keep it compact and honest:
//   * PAGINATED — the first page shows PEOPLE_FACET_PAGE chips and a "+N more"
//     chip expands the rest; a library's long tail of background strangers
//     must not swallow the panel.
//   * SELECTED CHIPS ALWAYS SHOW — active picks are hoisted to the front of
//     page one, and a pick that isn't in the facet payload at all (a deep link
//     like /library/gallery?person=123 outside the server cap) is resolved
//     against /api/people once, so the active filter is always visible and
//     unpickable-blind never happens.
const PEOPLE_FACET_PAGE = 12;

function PeopleFacet({
  options,
  selected,
  mode,
  onToggle,
  onMode,
}: {
  options: PersonFacet[];
  selected: number[];
  mode: "any" | "all";
  onToggle: (id: number) => void;
  onMode: (mode: "any" | "all") => void;
}) {
  const [expanded, setExpanded] = useState(false);
  // Fallback directory for selected ids the facet payload doesn't carry.
  // Fetched lazily, once, only when such an id shows up.
  const [directory, setDirectory] = useState<PersonFacet[] | null>(null);

  const missing = useMemo(
    () => selected.filter((id) => !options.some((o) => o.id === id)),
    [selected, options],
  );

  useEffect(() => {
    if (missing.length === 0 || directory !== null) return;
    let alive = true;
    fetch("/api/people")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { people?: PersonFacet[] } | null) => {
        if (alive) setDirectory(d?.people ?? []);
      })
      .catch(() => {
        if (alive) setDirectory([]);
      });
    return () => {
      alive = false;
    };
  }, [missing, directory]);

  const { shown, hidden } = useMemo(() => {
    const resolvedMissing = missing.map(
      (id) =>
        directory?.find((p) => p.id === id) ?? { id, name: null },
    );
    // Selected first (facet order, then the resolved strays), rest after.
    const all = [
      ...options.filter((o) => selected.includes(o.id)),
      ...resolvedMissing.map((p) => ({ ...p, count: undefined })),
      ...options.filter((o) => !selected.includes(o.id)),
    ];
    const cut = Math.max(PEOPLE_FACET_PAGE, selected.length);
    const shown = expanded ? all : all.slice(0, cut);
    return { shown, hidden: all.length - shown.length };
  }, [options, selected, missing, directory, expanded]);

  if (shown.length === 0) return null;

  return (
    <div className="facet">
      <div className="facet-title facet-head">
        People
        {selected.length > 1 && (
          // Combinator, meaningful from two picks up: "any of them" (OR, the
          // categorical default) vs "together" (AND — every picked person in
          // frame at once).
          <span className="view-toggle" role="group" aria-label="How the picked people combine">
            <button
              className={`view-btn${mode !== "all" ? " active" : ""}`}
              onClick={() => onMode("any")}
              aria-pressed={mode !== "all"}
              title="Media with any of the picked people"
            >
              Any
            </button>
            <button
              className={`view-btn${mode === "all" ? " active" : ""}`}
              onClick={() => onMode("all")}
              aria-pressed={mode === "all"}
              title="Media where every picked person is in frame together"
            >
              Together
            </button>
          </span>
        )}
      </div>
      <div className="chips">
        {shown.map((p) => {
          const active = selected.includes(p.id);
          return (
            <button
              key={p.id}
              className={`chip person-chip${active ? " active" : ""}`}
              onClick={() => onToggle(p.id)}
              title={p.name ?? "Unnamed person"}
            >
              {p.cover_face_id != null && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  className="chip-face"
                  src={`/api/faces/${p.cover_face_id}/thumb`}
                  alt=""
                  loading="lazy"
                />
              )}
              {p.name ?? "Unnamed"}
              {p.count != null && <span className="chip-count">{p.count}</span>}
            </button>
          );
        })}
        {hidden > 0 && (
          <button
            className="chip"
            onClick={() => setExpanded(true)}
            title="Show every person in scope"
          >
            +{hidden} more
          </button>
        )}
        {expanded && hidden === 0 && shown.length > PEOPLE_FACET_PAGE && (
          <button
            className="chip"
            onClick={() => setExpanded(false)}
            title="Back to the first page"
          >
            Show fewer
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
      {/* People (cf. lib/people.ts): face chips, multi-pickable (ORed, like
          every categorical dimension). Paginated — see PeopleFacet. */}
      {(!!facets.people?.length || filters.person.length > 0) && (
        <PeopleFacet
          options={facets.people ?? []}
          selected={filters.person}
          mode={filters.person_mode ?? "any"}
          onToggle={(id) => u({ person: toggle(filters.person, id) })}
          onMode={(m) => u({ person_mode: m === "any" ? undefined : m })}
        />
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

      <RangeSlider
        title="ISO"
        scale="iso"
        bounds={{ min: facets.ranges.iso_min, max: facets.ranges.iso_max }}
        min={filters.iso_min}
        max={filters.iso_max}
        onChange={(r) => u({ iso_min: r.min, iso_max: r.max })}
      />
      <RangeSlider
        title="Focal"
        unit="mm"
        bounds={{ min: facets.ranges.focal_min, max: facets.ranges.focal_max }}
        min={filters.focal_min}
        max={filters.focal_max}
        onChange={(r) => u({ focal_min: r.min, focal_max: r.max })}
      />
      <RangeSlider
        title="Aperture"
        unit="f/"
        scale="aperture"
        bounds={{
          min: facets.ranges.aperture_min,
          max: facets.ranges.aperture_max,
        }}
        min={filters.aperture_min}
        max={filters.aperture_max}
        onChange={(r) => u({ aperture_min: r.min, aperture_max: r.max })}
      />
      <RangeSlider
        title="Size"
        unit="MB"
        scale="log"
        bounds={{
          min: toMB(facets.ranges.size_min, Math.floor),
          max: toMB(facets.ranges.size_max, Math.ceil),
        }}
        min={filters.size_min}
        max={filters.size_max}
        onChange={(r) => u({ size_min: r.min, size_max: r.max })}
      />
      <RangeSlider
        title="Sharpness"
        scale="log"
        bounds={{
          min: facets.ranges.sharpness_min,
          max: facets.ranges.sharpness_max,
        }}
        min={filters.sharpness_min}
        max={filters.sharpness_max}
        onChange={(r) => u({ sharpness_min: r.min, sharpness_max: r.max })}
        hint="Low = blurry. Set only a max to surface the soft shots; the score shows in the viewer’s info panel."
      />

      {!!facets.with_phash && (
        <div className="facet">
          <label
            className="hint"
            style={{ display: "flex", gap: 8, alignItems: "center" }}
          >
            <input
              type="checkbox"
              checked={!!filters.near_dup}
              onChange={(e) => u({ near_dup: e.target.checked || undefined })}
            />
            Near-duplicates
          </label>
          <div className="hint" style={{ marginTop: 4 }}>
            Shots with a visual look-alike in the same session (bursts,
            re-exports). Open one and use the viewer’s “Similar” strip to compare.
          </div>
        </div>
      )}

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

      {/* Finals ↔ sources (cf. lib/reconcile.ts). The link has a direction, and
          each surface only ever sees one end of it: a source can HAVE an edit,
          a final IS one. So each axis is gated on its own count — on the finals
          gallery "has an edit" is always empty, on incoming "is an edit" is,
          and the half that can't match simply doesn't render. Both pairs are
          tri-state (re-click the lit chip to clear back to "either"), like the
          Faces and Bursts toggles above. */}
      {(!!facets.edits?.with_edits || !!facets.edits?.linked) && (
        <div className="facet">
          <div className="facet-title">Before / after</div>
          <div className="chips">
            {!!facets.edits?.with_edits && (
              <>
                <button
                  className={`chip${filters.has_edit === true ? " active" : ""}`}
                  onClick={() =>
                    u({ has_edit: filters.has_edit === true ? undefined : true })
                  }
                  title="Captures you have since edited — the shot has an “after”"
                >
                  Has an edit
                  <span className="chip-count">{facets.edits.with_edits}</span>
                </button>
                <button
                  className={`chip${filters.has_edit === false ? " active" : ""}`}
                  onClick={() =>
                    u({
                      has_edit: filters.has_edit === false ? undefined : false,
                    })
                  }
                  title="Captures with no edit yet — what you have not published"
                >
                  Not edited yet
                  <span className="chip-count">
                    {facets.total - facets.edits.with_edits}
                  </span>
                </button>
              </>
            )}
            {!!facets.edits?.linked && (
              <>
                <button
                  className={`chip${filters.is_edit === true ? " active" : ""}`}
                  onClick={() =>
                    u({ is_edit: filters.is_edit === true ? undefined : true })
                  }
                  title="Edits matched back to the capture they came from"
                >
                  Linked to an original
                  <span className="chip-count">{facets.edits.linked}</span>
                </button>
                <button
                  className={`chip${filters.is_edit === false ? " active" : ""}`}
                  onClick={() =>
                    u({ is_edit: filters.is_edit === false ? undefined : false })
                  }
                  title="Edits we could not match to a capture"
                >
                  No original found
                  <span className="chip-count">
                    {facets.total - facets.edits.linked}
                  </span>
                </button>
              </>
            )}
          </div>
          <div className="hint" style={{ marginTop: 4 }}>
            Pairs each edited final with the capture it came from — open one and
            use the viewer’s Original/Edit toggle to compare.
            {!!facets.edits?.linked &&
              " “No original found” lists the edits reconciliation couldn’t match: an ambiguous filename, or a source that isn’t indexed."}
          </div>
        </div>
      )}

      {/* Burst / bracket stacks (cf. lib/bursts.ts). The grid collapses a pile
          to its cover, so "In a burst" lists one tile per run — the shortlist of
          every burst shot in scope. Hidden until the library holds a pile. */}
      {!!facets.bursts?.piles && (
        <div className="facet">
          <div className="facet-title">Bursts</div>
          <div className="chips">
            <button
              className={`chip${filters.stacked === true ? " active" : ""}`}
              onClick={() =>
                u({ stacked: filters.stacked === true ? undefined : true })
              }
              title="Frames that belong to a burst / bracket pile"
            >
              In a burst
              <span className="chip-count">{facets.bursts.piles}</span>
            </button>
            <button
              className={`chip${filters.stacked === false ? " active" : ""}`}
              onClick={() =>
                u({ stacked: filters.stacked === false ? undefined : false })
              }
              title="Shots taken on their own, outside any pile"
            >
              Standalone
            </button>
          </div>
          {/* Action (continuous shooting) vs bracket (exposure-bracketed / AEB)
              — cf. Burst.kind, lib/bursts.ts. Hidden while the library holds no
              bracket pile, so the split never shows as a dead toggle. */}
          {!!facets.bursts.bracket_piles && (
            <div className="chips" style={{ marginTop: 6 }}>
              <button
                className={`chip${filters.burst_kind === "action" ? " active" : ""}`}
                onClick={() =>
                  u({
                    burst_kind: filters.burst_kind === "action" ? undefined : "action",
                  })
                }
                title="Continuous-shooting piles — same exposure across the run"
              >
                Action
                <span className="chip-count">{facets.bursts.action_piles}</span>
              </button>
              <button
                className={`chip${filters.burst_kind === "bracket" ? " active" : ""}`}
                onClick={() =>
                  u({
                    burst_kind: filters.burst_kind === "bracket" ? undefined : "bracket",
                  })
                }
                title="Exposure-bracketed (AEB) piles — frames shot at different exposures"
              >
                Bracket
                <span className="chip-count">{facets.bursts.bracket_piles}</span>
              </button>
            </div>
          )}
          <div className="hint" style={{ marginTop: 4 }}>
            {facets.bursts.piles} pile{facets.bursts.piles === 1 ? "" : "s"} ·{" "}
            {facets.bursts.frames} frame
            {facets.bursts.frames === 1 ? "" : "s"}. Each pile shows as one
            cover tile (⧉ N) — open its session grid to expand the run.
          </div>
        </div>
      )}

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
