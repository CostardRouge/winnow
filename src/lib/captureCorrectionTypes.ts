// The shapes and pure rules of a capture-time correction (migration 0061,
// docs/CAPTURE-TIME.md), shared by the server (lib/captureCorrections.ts) and
// the dialog that previews and applies one (app/CaptureTimeModal.tsx). No
// database, no Node: the client imports it.
//
// Every time here is a LOCAL WALL CLOCK where the frame was taken — the
// reading the capture day is filed by (0046) — expressed as epoch
// milliseconds of that wall clock read as UTC, and printed in UTC. That is the
// only reading a photographer can check against his memory ("I was at the
// lookout at 05:40"), whatever zone the browser sits in.

export type CorrectionMode = "shift" | "set" | "match" | "zone" | "revert";

/** What the dialog sends: a selection, the bodies whose clock was wrong, and
 * one way of stating the right time. */
export type CorrectionRequest = {
  ids: number[];
  /** The bodies (`assets.device`) that move; "" names "no body". Absent or
   * null: every body in the selection moves. */
  devices?: string[] | null;
  mode: CorrectionMode;
  /** mode "shift": seconds to add to the moment every ticked frame states. */
  shiftS?: number;
  /** mode "set": one frame's local time, `YYYY-MM-DDTHH:MM[:SS]`; the others
   * keep their gaps from it. */
  set?: { id: number; local: string };
  /** mode "match": a frame from the wrong clock and one from a right clock
   * that show the same moment; `round` rounds the measured gap to 15 min (a
   * zone mistake is whole quarter hours, a drifting clock is not). */
  pair?: { wrongId: number; rightId: number; round: boolean };
  /** mode "zone": the IANA zone the camera's clock was on, and the one the
   * photographer was in. A file that WROTE its zone had the right moment:
   * only the zone its day is filed in changes ('manual'). A wall clock (no
   * zone in the file) is shifted by the difference at its own date. */
  zone?: { from: string; to: string };
};

/** A frame offered as "the same moment" in Match a frame. */
export type MatchCandidate = {
  id: number;
  filename: string;
  device: string | null;
  local: string;
  /** CLIP cosine similarity (0–1) when both frames are embedded with the
   * same model, else null. */
  similarity: number | null;
  /** Perceptual-hash distance (bits) when CLIP could not compare them. */
  hamming: number | null;
};

export type CorrectionBody = {
  device: string | null;
  count: number;
  moving: boolean;
};

export type CorrectionPlan = {
  mode: CorrectionMode;
  /** The frame "Set the time" talks about, with its current local time. */
  reference: {
    id: number;
    filename: string;
    device: string | null;
    local: string;
    moving: boolean;
  } | null;
  /** The delta every moving frame receives; null for a revert, and for a
   * time-zone correction, whose shift is per frame (0 for a file that wrote
   * its zone, the zones' difference at its date for a wall clock). */
  deltaS: number | null;
  /** mode "zone": frames whose zone is set without moving their moment, and
   * frames whose clock is shifted. */
  zoneOnly: number;
  shifted: number;
  /** mode "match": the pair the shift was measured on, and the frames
   * offered as the same moment as `wrong`. */
  pair: {
    wrong: { id: number; filename: string; device: string | null; local: string } | null;
    right: { id: number; filename: string; device: string | null; local: string } | null;
    measuredS: number | null;
  } | null;
  candidates: MatchCandidate[];
  /** The most common zone of the selection's own positions: where "You
   * were in" starts. */
  placeZone: string | null;
  /** Ids the caller sent, and the rows they expand to: a burst pile cut by
   * the selection is taken whole, and a pair's other file follows. */
  selected: number;
  expanded: number;
  bodies: CorrectionBody[];
  /** Rows whose shift changes, and rows of ticked bodies that stay put
   * (a revert of a frame never corrected, a zero shift). */
  moving: number;
  unchanged: number;
  /** Local capture days, before → after, oldest first. */
  days: Array<{ date: string; before: number; after: number }>;
  /** A few frames spread over the moving set (local wall clocks, ISO without
   * a zone). */
  samples: Array<{
    id: number;
    filename: string;
    device: string | null;
    before: string;
    after: string;
    fileSays: string;
  }>;
  sessions: Array<{ id: number; name: string; count: number }>;
  /** Moving frames a GPS track placed at the OLD moment: matched again
   * against the same track at the new one — moved, unchanged, or taken off
   * when the track has no fix then. */
  trackPlaced: number;
  track: { moved: number; same: number; cleared: number };
  /** Moving frames already pushed to Immich: their date there is updated
   * after the apply (Immich reads the file's own date otherwise). */
  inImmich: number;
  /** Moving frames that already carry a correction (it is added to). */
  alreadyCorrected: number;
};

export type CorrectionRecord = {
  id: number;
  created_at: string;
  username: string | null;
  via: string | null;
  mode: CorrectionMode;
  shift_s: number | null;
  zone_from: string | null;
  zone_to: string | null;
  asset_count: number;
  report: CorrectionPlan;
  undone_at: string | null;
  undo_report: UndoReport | null;
};

export type UndoReport = {
  restored: number;
  /** Rows a later correction (or a revert) has moved since: left as they are. */
  skipped: number;
};

/** What the push of corrected dates to Immich did (lib/immichDates.ts). */
export type ImmichDateReport = {
  updated: number;
  failed: number;
  error: string | null;
};

/** A body whose clock looks wrong in one session (docs/CAPTURE-TIME.md §7):
 * a suggestion only, applied through the same dialog. */
export type ClockSuggestion = {
  sessionId: number;
  sessionName: string;
  /** The body the suggestion would move ("" = no body), and how many media
   * it has in the session. */
  device: string;
  media: number;
  /** The body it was measured against (look-alike pairs), when it was. */
  reference: string | null;
  shiftS: number;
  evidence:
    | { kind: "pairs"; pairs: number; agreeing: number; example: { wrongId: number; rightId: number } }
    | { kind: "track"; frames: number; conflicts: number; resolved: number };
};

/** The largest selection one gesture may move, stated rather than silently
 * truncated (docs/SILENT-LIMITS-AUDIT.md). */
export const MAX_CORRECTION_ROWS = 50_000;

/** ±20 years: past that it is not a clock, it is a typo. */
export const MAX_SHIFT_S = 20 * 366 * 24 * 3600;

/**
 * A frame's local wall clock: the stored moment shifted by the place's
 * offset — except an `exif-wall` time, whose stored value already IS the
 * local wall clock (the same rule as the 0046 trigger).
 */
export function localWallMs(
  capturedMs: number,
  capturedAtSource: string | null,
  offsetMin: number | null,
): number {
  if (capturedAtSource === "exif-wall") return capturedMs;
  return capturedMs + (offsetMin ?? 0) * 60_000;
}

/**
 * Epoch ms of an instant in pg's text form ("2026-11-12 05:41:00+00", which
 * Safari's Date.parse refuses — lib/instant.ts) or ISO; null when unreadable.
 */
export function instantMs(text: string | null | undefined): number | null {
  if (!text) return null;
  const iso = text
    .trim()
    .replace(" ", "T")
    .replace(/([+-]\d{2})$/, "$1:00");
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** What a moved row looks like after a correction, as the API returns it —
 * the fields a grid patches in place. */
export type MovedRow = {
  id: number;
  captured_at: string | null;
  captured_at_file: string | null;
  capture_shift_s: number | null;
  capture_offset_min: number | null;
  capture_offset_source: string | null;
  // A GPS-track position matched again at the new moment (or taken off).
  gps: { lat: number; lon: number } | null;
  gps_source: string | null;
  place_city: string | null;
  place_country: string | null;
};

/** Patch a list of rows with what a correction moved. */
export function applyMoved<T extends { id: number }>(items: T[], moved: MovedRow[]): T[] {
  if (!moved.length) return items;
  const byId = new Map(moved.map((m) => [m.id, m]));
  return items.map((a) => {
    const m = byId.get(a.id);
    return m ? { ...a, ...m } : a;
  });
}

/**
 * The date to give Immich for a frame (lib/immichDates.ts): its local wall
 * clock with the place's offset, "2026-11-12T05:41:00+10:00". With no offset
 * known the stored moment is sent as UTC — for a wall clock that is the wall
 * time read as UTC, the same reading the capture day falls back to.
 */
export function immichDateIso(
  capturedMs: number,
  capturedAtSource: string | null,
  offsetMin: number | null,
): string {
  if (offsetMin == null) return new Date(capturedMs).toISOString().replace(".000Z", "Z");
  const wall = wallIso(localWallMs(capturedMs, capturedAtSource, offsetMin));
  const sign = offsetMin < 0 ? "-" : "+";
  const a = Math.abs(offsetMin);
  const hh = String(Math.floor(a / 60)).padStart(2, "0");
  const mm = String(a % 60).padStart(2, "0");
  return `${wall}${sign}${hh}:${mm}`;
}

/** `YYYY-MM-DDTHH:MM[:SS]` read as a wall clock (UTC epoch ms), or null. */
export function parseLocalInput(local: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, s ? +s : 0);
  const back = new Date(ms);
  // Reject 2026-02-31 and friends rather than rolling them over.
  if (back.getUTCMonth() !== +mo - 1 || back.getUTCDate() !== +d) return null;
  return ms;
}

/** A wall clock as `YYYY-MM-DDTHH:MM:SS` (no zone: it is local by nature). */
export function wallIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19);
}

/** The shift a row holds after a gesture adds `delta`: a sum of zero is no
 * correction at all, stored as NULL. */
export function nextShift(old: number | null, delta: number | null): number | null {
  if (delta == null) return null; // a revert
  const v = (old ?? 0) + delta;
  return v === 0 ? null : v;
}

/** "+9 h", "−1 h 30 min", "+2 days 3 h", "+37 s". */
export function formatShift(seconds: number | null): string {
  if (seconds == null || seconds === 0) return "none";
  const sign = seconds < 0 ? "−" : "+";
  let rest = Math.abs(Math.round(seconds));
  const days = Math.floor(rest / 86_400);
  rest -= days * 86_400;
  const h = Math.floor(rest / 3600);
  rest -= h * 3600;
  const m = Math.floor(rest / 60);
  const s = rest - m * 60;
  const parts: string[] = [];
  if (days) parts.push(`${days} ${days === 1 ? "day" : "days"}`);
  if (h) parts.push(`${h} h`);
  if (m) parts.push(`${m} min`);
  if (s) parts.push(`${s} s`);
  return `${sign}${parts.join(" ")}`;
}

/** A wall-clock ISO (as `wallIso` writes it) for a person: "Tue 12 Nov 2026, 05:41". */
export function formatWall(iso: string | null | undefined, withSeconds = false): string {
  if (!iso) return "—";
  const ms = Date.parse(`${iso.slice(0, 19)}Z`);
  if (Number.isNaN(ms)) return "—";
  return new Date(ms).toLocaleString("en-GB", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    ...(withSeconds ? { second: "2-digit" } : {}),
  });
}

/** A wall clock in a small space: "12 Nov 05:31:40". */
export function formatWallShort(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.parse(`${iso.slice(0, 19)}Z`);
  if (Number.isNaN(ms)) return "—";
  const d = new Date(ms);
  const day = d.toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short" });
  return `${day} ${iso.slice(11, 19)}`;
}

/** A capture day ("2026-11-12") for a person: "Tue 12 Nov 2026". */
export function formatDay(date: string): string {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms)) return date;
  return new Date(ms).toLocaleDateString("en-GB", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
