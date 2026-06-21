// Friendly display names for the cryptic camera/device strings that some
// cameras write into their EXIF metadata.
//
// A few devices report internal codes rather than their marketing name:
//   - DJI drones expose the flight-controller board code ("DJI FC8482" is the
//     Mini 4 Pro).
//   - Phones often report an internal SKU ("OnePlus A5010" is the OnePlus 5T).
//
// Those raw strings land in `assets.device` / `assets.camera_model` (see
// `lib/extract.ts`) and surface verbatim in the library filters. This table maps
// the raw EXIF value to a human-friendly name for *display only* — filtering and
// the stored values stay on the raw string, so the table can grow freely without
// touching the database or any query.
//
// Keys may be either the combined device ("Make Model", e.g. "DJI FC8482") or
// the bare camera model (e.g. "FC8482"); add the entry in whichever form shows
// up in the filter chip. Matching is case-insensitive and whitespace-tolerant.
export const CAMERA_FRIENDLY_NAMES: Record<string, string> = {
  // DJI drones — EXIF Model is the flight-controller board code.
  "DJI FC8482": "DJI Mini 4 Pro",
    // SONY cameras
    "SONY ILCE-7CM2": "Sony A7C II",
    "SONY ILCE-6700": "Sony A6700",

  // OnePlus phones — EXIF Model is the internal SKU.
  "OnePlus A5010": "OnePlus 5T",
};

// trim + collapse internal whitespace + lowercase, so lookups tolerate the
// casing/spacing quirks different cameras use.
function normalize(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

// Lowercased index built once from CAMERA_FRIENDLY_NAMES for O(1) lookups.
const LOOKUP: Record<string, string> = Object.fromEntries(
  Object.entries(CAMERA_FRIENDLY_NAMES).map(([raw, friendly]) => [
    normalize(raw),
    friendly,
  ]),
);

// Returns the friendly name for a raw EXIF device/camera string, falling back to
// the original value when unmapped (so unknown cameras still display), and to ""
// for null/undefined.
export function friendlyCameraName(raw: string | null | undefined): string {
  if (!raw) return "";
  return LOOKUP[normalize(raw)] ?? raw;
}
