// Small display formatters shared by the viewers / metadata panels. Pure, no
// deps — kept out of the components so the gallery and session grids format
// dates, sizes and dimensions identically.

// Bytes -> "24.3 MB" / "812 KB" / "0 B". Binary units (1024).
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let val = bytes / 1024;
  let u = 0;
  while (val >= 1024 && u < units.length - 1) {
    val /= 1024;
    u++;
  }
  return `${val < 10 ? val.toFixed(2) : val < 100 ? val.toFixed(1) : Math.round(val)} ${units[u]}`;
}

// ISO timestamp -> localized "Jun 20, 2026, 2:30 PM" (locale of the browser).
// Returns "—" for null/unparseable input.
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Seconds -> "0:42" / "1:23" / "1:02:05".
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// Compact corner badge for a grid tile. A RAW+JPEG pair reads "<direct>/RAW" —
// the lighter direct file (JPEG/HEIF) first, then its RAW companion — so a
// glance shows it's one logical media made of two files; an iPhone Live Photo
// reads "LIVE"; a lone file is just its extension. The badge CSS uppercases it.
export function formatBadge(
  ext: string,
  companionExt?: string | null,
  groupKind?: "raw_jpeg" | "live_photo" | null,
): string {
  if (groupKind === "live_photo") return "LIVE";
  const e = ext.replace(".", "");
  return companionExt ? `${e}/RAW` : e;
}

// Width × height -> "6000 × 4000 (24 MP)". Megapixels omitted when tiny.
export function formatDimensions(
  width: number | null | undefined,
  height: number | null | undefined,
): string | null {
  if (!width || !height) return null;
  const mp = (width * height) / 1_000_000;
  const mpStr = mp >= 0.1 ? ` (${mp < 10 ? mp.toFixed(1) : Math.round(mp)} MP)` : "";
  return `${width} × ${height}${mpStr}`;
}
