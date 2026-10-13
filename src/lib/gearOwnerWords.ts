// Whose camera, in words (migration 0053, lib/gearOwners.ts) — shared by the
// /gear shelf (its marks' names and tooltips) and the viewer's Device row, so
// the two say an owner the same way. Client-safe: no database, no React.
import type { GearOwner } from "./gearTypes";

// The app's own month table (cf. lib/format.ts): Chromium's en-GB says "Sept".
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "AY" for Aymeric, "WP" for the wedding photographer, "··" for no one named. */
export function initials(name: string | null): string {
  if (!name) return "··";
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : words[0]?.slice(0, 2) ?? "";
  return letters.toUpperCase() || "··";
}

/** "Mar 2016" — the span's granularity wherever it is printed. */
export function spanDate(day: string): string {
  const [y, m] = day.split("-").map(Number);
  return MONTHS[m - 1] ? `${MONTHS[m - 1]} ${y}` : day;
}

/** The answer in words — a mark's accessible name and its tooltip. */
export function ownerWords(owner: GearOwner | null): string {
  if (!owner) return "Not sorted";
  if (owner.owner === "none") return "Not a camera";
  if (owner.owner === "other")
    return owner.owner_name ? `${owner.owner_name}’s` : "Someone else’s";
  const from = owner.owned_from ? spanDate(owner.owned_from) : null;
  const until = owner.owned_until ? spanDate(owner.owned_until) : null;
  if (from && until) return `Mine, ${from} – ${until}`;
  if (from) return `Mine since ${from}`;
  if (until) return `Mine until ${until}`;
  return "Mine";
}

export type ShotByLine = { kind: "mine" | "other" | "none"; text: string };

/**
 * What the viewer prints after a frame's body: whose camera shot THIS frame.
 * `shotBy` is the bucket SHOT_BY_SQL put the frame in (the filter's own
 * answer, so the line and "Shot by" can never disagree); `owner` is the body's
 * row, for the name and the span. A 'mine' body outside its span shot the
 * frame in someone else's hands, and the line says which side of the span.
 * Null when there is nothing to say: no body, or a body not sorted yet.
 */
export function shotByLine(
  shotBy: string | null | undefined,
  owner: GearOwner | null | undefined,
  capturedAt: string | null | undefined,
): ShotByLine | null {
  if (!owner || shotBy === "unsorted" || !shotBy) return null;
  if (shotBy === "me") return { kind: "mine", text: "mine" };
  if (shotBy === "none")
    return owner.owner === "none" ? { kind: "none", text: "not a camera" } : null;
  if (owner.owner === "other")
    return {
      kind: "other",
      text: owner.owner_name ? `${owner.owner_name}’s` : "someone else’s",
    };
  // A body of mine, outside the span it was mine.
  const day = capturedAt?.slice(0, 10) ?? "";
  if (owner.owned_from && day < owner.owned_from)
    return { kind: "other", text: `before it was yours (since ${spanDate(owner.owned_from)})` };
  if (owner.owned_until)
    return { kind: "other", text: `after it was yours (until ${spanDate(owner.owned_until)})` };
  return { kind: "other", text: "someone else’s" };
}
