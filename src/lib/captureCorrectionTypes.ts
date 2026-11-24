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

export type CorrectionMode = "shift" | "set" | "revert";

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
  /** The delta every moving frame receives; null for a revert. */
  deltaS: number | null;
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
  /** Moving frames a GPS track placed at the OLD moment: they keep that
   * position for now (re-matching is phase 2), and the dialog says so. */
  trackPlaced: number;
  /** Moving frames that already carry a correction (it is added to). */
  alreadyCorrected: number;
};

export type CorrectionRecord = {
  id: number;
  created_at: string;
  username: string | null;
  via: string | null;
  mode: CorrectionMode | "match" | "zone";
  shift_s: number | null;
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
