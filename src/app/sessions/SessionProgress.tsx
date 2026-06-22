// Two-tone triage progress bar: the green band is picks, the red band rejects,
// the remaining track is what's still unrated. Shared by every surface that
// shows "how far along is this session" — the session list rows/cards, the
// session detail header, and the Sift dashboard — so the read is identical
// everywhere.
//
// `compact` shrinks it for dense lists (thinner bar, a bare "NN%" label). The
// full size appends the word "triaged" and is what the detail header uses.

export type TriageCounts = {
  picks: number;
  rejects: number;
  /** Total cullable media in the session (picks + rejects + unrated). */
  total: number;
};

export default function SessionProgress({
  picks,
  rejects,
  total,
  compact = false,
  className,
}: TriageCounts & { compact?: boolean; className?: string }) {
  const triaged = picks + rejects;
  const pct = total ? Math.round((triaged / total) * 100) : 0;
  const pickPct = total ? (picks / total) * 100 : 0;
  const rejectPct = total ? (rejects / total) * 100 : 0;

  return (
    <div
      className={[
        "session-progress",
        compact && "is-compact",
        total > 0 && triaged >= total && "is-done",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      title={total ? `${triaged} of ${total} triaged` : "No media to triage yet"}
    >
      <div className="session-progress-track">
        <span className="session-progress-fill is-pick" style={{ width: `${pickPct}%` }} />
        <span className="session-progress-fill is-reject" style={{ width: `${rejectPct}%` }} />
      </div>
      <span className="session-progress-label">
        {total === 0 ? "—" : compact ? `${pct}%` : `${pct}% triaged`}
      </span>
    </div>
  );
}
