// Triage progress bar: the green band is picks, the red band rejects, the amber
// band skips (reviewed but neither kept nor culled), and the remaining track is
// what's still unrated. Shared by every surface that shows "how far along is
// this session" — the session list rows/cards, the session detail header, and
// the Sift dashboard — so the read is identical everywhere.
//
// "Triaged" / "done" is verdict COVERAGE: a session is done once nothing is left
// unrated, so the bar fills (and reads green) whether the survivors are picks,
// rejects or skips. `compact` shrinks it for dense lists (thinner bar, a bare
// "NN%" label); the full size appends the word "sorted".

export type TriageCounts = {
  picks: number;
  rejects: number;
  /** Reviewed-but-undecided. Counts as triaged; fills the amber band. */
  skips?: number;
  /** Total cullable media in the session (picks + rejects + skips + unrated). */
  total: number;
};

export default function SessionProgress({
  picks,
  rejects,
  skips = 0,
  total,
  compact = false,
  className,
}: TriageCounts & { compact?: boolean; className?: string }) {
  const triaged = picks + rejects + skips;
  const pct = total ? Math.round((triaged / total) * 100) : 0;
  const pickPct = total ? (picks / total) * 100 : 0;
  const rejectPct = total ? (rejects / total) * 100 : 0;
  const skipPct = total ? (skips / total) * 100 : 0;

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
      title={total ? `${triaged} of ${total} sorted` : "No media to triage yet"}
    >
      <div className="session-progress-track">
        <span className="session-progress-fill is-pick" style={{ width: `${pickPct}%` }} />
        <span className="session-progress-fill is-reject" style={{ width: `${rejectPct}%` }} />
        <span className="session-progress-fill is-skip" style={{ width: `${skipPct}%` }} />
      </div>
      <span className="session-progress-label">
        {total === 0 ? "—" : compact ? `${pct}%` : `${pct}% sorted`}
      </span>
    </div>
  );
}
