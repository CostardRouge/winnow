"use client";

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
  extensions: VC[];
  media_types: VC[];
  tags: VC[];
};
type VC = { value: string | number; count: number };

export type Filters = {
  media_type: string[];
  ext: string[];
  device: string[];
  camera_model: string[];
  lens: string[];
  tags: string[];
  year: number[];
  month: number[];
  day: number[];
  // Pilotés par l'arbre (drill-down) :
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
  size_min?: number; // Mo (UI) — converti en octets dans la query
  size_max?: number;
  has_gps?: boolean;
};

export const EMPTY_FILTERS: Filters = {
  media_type: [],
  ext: [],
  device: [],
  camera_model: [],
  lens: [],
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
}: {
  facets: Facets | null;
  filters: Filters;
  set: (f: Filters) => void;
}) {
  if (!facets) return <div className="spinner">Loading filters…</div>;
  const u = (patch: Partial<Filters>) => set({ ...filters, ...patch });

  return (
    <div className="filter-panel">
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
      <Chips
        title="Device"
        options={facets.devices}
        selected={filters.device}
        onToggle={(v) => u({ device: toggle(filters.device, String(v)) })}
      />
      <Chips
        title="Camera"
        options={facets.camera_models}
        selected={filters.camera_model}
        onToggle={(v) => u({ camera_model: toggle(filters.camera_model, String(v)) })}
      />
      <Chips
        title="Lens"
        options={facets.lenses}
        selected={filters.lens}
        onToggle={(v) => u({ lens: toggle(filters.lens, String(v)) })}
      />

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
    </div>
  );
}
