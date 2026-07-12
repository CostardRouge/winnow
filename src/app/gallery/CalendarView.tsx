"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { fetchJson } from "@/lib/fetchJson";
import { LazyImage, Icons, Spinner } from "../ui";

// Calendar view for the gallery: a month-at-a-glance wall calendar where every
// day that holds media shows a cover thumbnail and a count. Picking a day drills
// the rest of the section into that date (the host applies it as a date filter
// and drops back to the Grid). The data is filter-aware — it shares the gallery's
// Filters/Browse aside via the `query` it receives — and comes from
// /api/assets/calendar (per-day counts + cover + the full filtered span).

type DayCount = { date: string; count: number; cover_id: number };
type CalendarData = {
  days: DayCount[];
  bounds: { min: string | null; max: string | null };
};

// Monday-first week (cleaner grid, matches the rest of the EU-style date UI).
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");
// YYYY-MM-DD from a Date read in UTC (capture_date is materialized at UTC).
const isoDate = (d: Date) =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
// A month, identified by year + 0-based month, collapsed to a single ordinal so
// arithmetic (shifting, clamping against the data bounds) stays trivial.
const monthIndex = (y: number, m: number) => y * 12 + m;
const isoMonthIndex = (iso: string) => {
  const [y, m] = iso.split("-").map(Number);
  return monthIndex(y, m - 1);
};

// The 6-week (max) grid covering a month: the days run from the Monday on/before
// the 1st to the Sunday on/after the last day, so the adjacent-month spillover
// fills the corners. `from`/`to` bound the matching API window.
function buildGrid(y: number, m: number) {
  const first = new Date(Date.UTC(y, m, 1));
  const offset = (first.getUTCDay() + 6) % 7; // Mon-first lead-in
  const start = new Date(Date.UTC(y, m, 1 - offset));
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const cells = Math.ceil((offset + daysInMonth) / 7) * 7;
  const grid = Array.from({ length: cells }, (_, k) => new Date(start.getTime() + k * DAY_MS));
  return { grid, from: isoDate(grid[0]), to: isoDate(grid[grid.length - 1]) };
}

function nowMonth() {
  const n = new Date();
  return { y: n.getUTCFullYear(), m: n.getUTCMonth() };
}

export default function CalendarView({
  query,
  onOpenDate,
  filterCount = 0,
  onClearFilters,
}: {
  /** Active scope + filters, ready to append to the calendar API call. */
  query: string;
  /** Drill into a single day — the host applies it as a date filter + Grid. */
  onOpenDate: (date: string) => void;
  /** How many filter dimensions currently narrow the library (0 = none). Lets
   *  the calendar say when what it shows is a filtered subset, and explain an
   *  empty month that the filters caused. */
  filterCount?: number;
  /** Clear every active filter (offered when a filtered month comes up empty). */
  onClearFilters?: () => void;
}) {
  const [month, setMonth] = useState(nowMonth);
  const [data, setData] = useState<CalendarData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped to force a refetch of the same month (the Retry button) — the
  // window strings alone don't change, so they can't drive the reload.
  const [reloadKey, setReloadKey] = useState(0);
  // Only auto-jump to the latest populated month once per filter set, so the
  // user's manual navigation is never yanked back.
  const autoJumped = useRef(false);
  useEffect(() => {
    autoJumped.current = false;
  }, [query]);

  const { grid, from, to } = useMemo(() => buildGrid(month.y, month.m), [month]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchJson<CalendarData>(`/api/assets/calendar?${query}&from=${from}&to=${to}`)
      .then((d) => {
        if (cancelled) return;
        // First load with nothing this month: hop to the month that holds the
        // most recent media so the view opens on something to look at.
        if (!autoJumped.current && d.days.length === 0 && d.bounds.max) {
          autoJumped.current = true;
          const [my, mm] = d.bounds.max.split("-").map(Number);
          if (my !== month.y || mm - 1 !== month.m) {
            setMonth({ y: my, m: mm - 1 });
            return; // a refetch for the new month follows
          }
        }
        autoJumped.current = true;
        setData(d);
      })
      .catch((e: Error) => {
        if (!cancelled) {
          setError(e.message);
          setData(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, from, to, reloadKey]);

  const byDate = useMemo(() => {
    const map = new Map<string, DayCount>();
    for (const d of data?.days ?? []) map.set(d.date, d);
    return map;
  }, [data]);

  const monthTotal = useMemo(
    () =>
      (data?.days ?? []).reduce(
        (sum, d) => (isoMonthIndex(d.date) === monthIndex(month.y, month.m) ? sum + d.count : sum),
        0,
      ),
    [data, month],
  );

  // Clamp navigation to the filtered data span (when known).
  const cur = monthIndex(month.y, month.m);
  const minIdx = data?.bounds.min ? isoMonthIndex(data.bounds.min) : null;
  const maxIdx = data?.bounds.max ? isoMonthIndex(data.bounds.max) : null;
  const atMin = minIdx != null && cur <= minIdx;
  const atMax = maxIdx != null && cur >= maxIdx;

  const shift = (months: number) =>
    setMonth(({ y, m }) => {
      const total = monthIndex(y, m) + months;
      return { y: Math.floor(total / 12), m: ((total % 12) + 12) % 12 };
    });

  // Direct jump from the month/year pickers, clamped to the filtered data span
  // (picking the min/max year keeps the month inside the populated range).
  const jumpTo = (y: number, m: number) => {
    let idx = monthIndex(y, m);
    if (minIdx != null) idx = Math.max(idx, minIdx);
    if (maxIdx != null) idx = Math.min(idx, maxIdx);
    setMonth({ y: Math.floor(idx / 12), m: ((idx % 12) + 12) % 12 });
  };

  // Year picker options: the filtered data span when known (newest first), else
  // a window around today; the displayed year always rides along so the select
  // never shows a value it doesn't contain.
  const years = useMemo(() => {
    const nowY = new Date().getUTCFullYear();
    const lo = minIdx != null ? Math.floor(minIdx / 12) : Math.min(month.y, nowY - 10);
    const hi = maxIdx != null ? Math.floor(maxIdx / 12) : Math.max(month.y, nowY);
    const list: number[] = [];
    for (let y = hi; y >= lo; y--) list.push(y);
    if (!list.includes(month.y)) list.push(month.y);
    return list.sort((a, b) => b - a);
  }, [minIdx, maxIdx, month.y]);

  const todayIso = isoDate(new Date());

  return (
    <main className="gallery-main">
      <div className="cal-wrap">
        <div className="cal-head">
          <div className="cal-nav" role="group" aria-label="Change month">
            <button
              className="icon-toggle"
              onClick={() => shift(-12)}
              disabled={atMin}
              aria-label="Previous year"
              title="Previous year"
            >
              «
            </button>
            <button
              className="icon-toggle"
              onClick={() => shift(-1)}
              disabled={atMin}
              aria-label="Previous month"
              title="Previous month"
            >
              {Icons.back}
            </button>
            {/* The title doubles as the period picker: native selects (OS wheel
                on phones) jump straight to any month/year in the data span. */}
            <div className="cal-title" role="group" aria-label="Jump to a month">
              <select
                className="cal-select"
                value={month.m}
                onChange={(e) => jumpTo(month.y, Number(e.target.value))}
                aria-label="Month"
                title="Jump to a month"
              >
                {MONTHS.map((name, i) => {
                  const idx = monthIndex(month.y, i);
                  const out =
                    (minIdx != null && idx < minIdx) ||
                    (maxIdx != null && idx > maxIdx);
                  return (
                    <option key={name} value={i} disabled={out}>
                      {name}
                    </option>
                  );
                })}
              </select>
              <select
                className="cal-select"
                value={month.y}
                onChange={(e) => jumpTo(Number(e.target.value), month.m)}
                aria-label="Year"
                title="Jump to a year"
              >
                {years.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </div>
            <button
              className="icon-toggle"
              onClick={() => shift(1)}
              disabled={atMax}
              aria-label="Next month"
              title="Next month"
            >
              {Icons.chevronRight}
            </button>
            <button
              className="icon-toggle"
              onClick={() => shift(12)}
              disabled={atMax}
              aria-label="Next year"
              title="Next year"
            >
              »
            </button>
          </div>
          <span className="spacer" />
          <span className="cal-month-total" role="status">
            {loading
              ? "Loading…"
              : `${monthTotal} this month${filterCount > 0 ? " · filtered" : ""}`}
          </span>
          <button className="btn" onClick={() => setMonth(nowMonth())} title="Jump to the current month">
            Today
          </button>
        </div>

        {error ? (
          <div className="error-box">
            <span>Couldn’t load the calendar: {error}</span>
            <button className="btn" onClick={() => setReloadKey((k) => k + 1)}>
              Retry
            </button>
          </div>
        ) : (
          <div className={`cal-board${loading ? " is-loading" : ""}`} aria-busy={loading}>
            {/* Floating pill over the dimmed board while a fetch is in flight —
                both the first load and every month/filter change. */}
            {loading && (
              <div className="cal-loading" role="status" aria-live="polite">
                <Spinner sm />
                Loading calendar…
              </div>
            )}
            <div className="cal-weekdays">
              {WEEKDAYS.map((w) => (
                <div key={w} className="cal-weekday">
                  {w}
                </div>
              ))}
            </div>
            <div className="cal-grid">
              {grid.map((cell) => {
                const iso = isoDate(cell);
                const info = byDate.get(iso);
                const outside = cell.getUTCMonth() !== month.m;
                const has = Boolean(info);
                return (
                  <button
                    key={iso}
                    type="button"
                    className={`cal-day${outside ? " is-outside" : ""}${
                      has ? " has-media" : ""
                    }${iso === todayIso ? " is-today" : ""}`}
                    disabled={!has}
                    onClick={() => info && onOpenDate(iso)}
                    title={
                      has
                        ? `${info!.count} item${info!.count === 1 ? "" : "s"} on ${iso}`
                        : iso
                    }
                  >
                    {info && (
                      <LazyImage
                        className="cal-thumb"
                        src={`/api/assets/${info.cover_id}/thumb`}
                        rootMargin="200px"
                      />
                    )}
                    <span className="cal-day-num">
                      {outside
                        ? `${MONTHS[cell.getUTCMonth()].slice(0, 3)} ${cell.getUTCDate()}`
                        : cell.getUTCDate()}
                    </span>
                    {info && <span className="cal-day-count">{info.count}</span>}
                  </button>
                );
              })}
            </div>
            {!loading && monthTotal === 0 && (
              <div className="cal-empty hint">
                {filterCount > 0 ? (
                  <>
                    <span>
                      Nothing in {MONTHS[month.m]} {month.y} matches the{" "}
                      {filterCount === 1 ? "active filter" : `${filterCount} active filters`}.
                    </span>
                    {onClearFilters && (
                      <button className="btn" onClick={onClearFilters}>
                        Clear filters
                      </button>
                    )}
                  </>
                ) : (
                  <span>
                    No media captured in {MONTHS[month.m]} {month.y}.
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
