"use client";

// "Clocks that look wrong" — the suggestions of lib/clockSuggestions.ts as
// cards (docs/CAPTURE-TIME.md §7). One card per session and body: what is off,
// by how much, and the evidence in words, with the thresholds printed. A card
// never moves anything: Review opens the one correction dialog pre-filled
// (the host does that), Not a mistake is remembered for that session, body
// and shift. Shared by a session's page and Settings › Pipeline › Dates &
// places.
import Link from "next/link";
import { friendlyCameraName } from "@/lib/cameraLabels";
import { type ClockSuggestion, formatShift } from "@/lib/captureCorrectionTypes";

const n = (v: number) => v.toLocaleString("en-GB");
const body = (device: string) => (device ? friendlyCameraName(device) : "Media with no camera body");

export function suggestionKey(s: ClockSuggestion): string {
  return `${s.sessionId}\u0000${s.device}\u0000${s.shiftS}`;
}

function evidence(s: ClockSuggestion): string {
  if (s.evidence.kind === "pairs")
    return `Shifted ${formatShift(s.shiftS)}, ${n(s.evidence.agreeing)} of its ${n(s.evidence.pairs)} look-alike photos with the ${body(s.reference ?? "")} fall within 15 minutes of each other.`;
  return `${n(s.evidence.conflicts)} of its ${n(s.evidence.frames)} frames with a position of their own sit more than 25 km from your GPS track at the time they state; shifted ${formatShift(s.shiftS)}, ${n(s.evidence.resolved)} land on it.`;
}

export default function ClockSuggestionCards({
  suggestions,
  onReview,
  onDismiss,
  linkSessions = false,
}: {
  suggestions: ClockSuggestion[];
  /** Opens the correction dialog pre-filled. Omitted where the media are not
   * at hand (Settings): the card then links to its session. */
  onReview?: (s: ClockSuggestion) => void;
  onDismiss: (s: ClockSuggestion) => void;
  linkSessions?: boolean;
}) {
  if (!suggestions.length) return null;
  return (
    <div className="clock-cards">
      {suggestions.map((s) => (
        <section key={suggestionKey(s)} className="clock-card" aria-label="A clock that looks wrong">
          <svg className="clock-card-ic" width="22" height="22" viewBox="0 0 24 24" aria-hidden>
            <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path d="M12 7v5l3.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <div className="clock-card-text">
            <strong>
              {body(s.device)} looks {formatShift(s.shiftS)} off
              {linkSessions && <> · {s.sessionName}</>}
            </strong>
            <span className="hint">{evidence(s)}</span>
          </div>
          <div className="clock-card-actions">
            <button type="button" className="btn btn-sm" onClick={() => onDismiss(s)}>
              Not a mistake
            </button>
            {onReview ? (
              <button type="button" className="btn btn-sm btn-primary" onClick={() => onReview(s)}>
                Review {n(s.media)}…
              </button>
            ) : (
              <Link href={`/sessions/${s.sessionId}?clock=1`} className="btn btn-sm btn-primary">
                Open the session
              </Link>
            )}
          </div>
        </section>
      ))}
    </div>
  );
}
