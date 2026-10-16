// How the Unplaced view words a time gap and a distance — shared by the cards
// (UnplacedPane) and the keyboard review (ReviewReady), which print the same
// evidence (docs/UNPLACED.md §12). Client-safe.

/** "47 s", "1 min 27 s", "12 min", "1 h 05". */
export function spanText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 10) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
}

/** "0 m", "40 m", "1.4 km". */
export function distText(m: number): string {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}
