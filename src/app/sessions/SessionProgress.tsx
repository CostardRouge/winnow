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
//
// `legend` adds the counts under the bar — "5 picks · 4 rejects · 5 to sort" —
// keyed by the same colours. It is the ONE place a session card states its
// numbers (UI review H3): the same three counts used to be drawn again as
// coloured pills beside the bar, and once more as the percentage.

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
  legend = false,
  className,
}: TriageCounts & { compact?: boolean; legend?: boolean; className?: string }) {
  const triaged = picks + rejects + skips;
  const unrated = Math.max(0, total - triaged);
  const pct = total ? Math.round((triaged / total) * 100) : 0;
  const pickPct = total ? (picks / total) * 100 : 0;
  const rejectPct = total ? (rejects / total) * 100 : 0;
  const skipPct = total ? (skips / total) * 100 : 0;
  const done = total > 0 && triaged >= total;

  const track = (
    <div className="session-progress-track">
      <span className="session-progress-fill is-pick" style={{ width: `${pickPct}%` }} />
      <span className="session-progress-fill is-reject" style={{ width: `${rejectPct}%` }} />
      <span className="session-progress-fill is-skip" style={{ width: `${skipPct}%` }} />
    </div>
  );
  const label = (
    <span className="session-progress-label">
      {total === 0 ? "—" : compact ? `${pct}%` : `${pct}% sorted`}
    </span>
  );

  return (
    <div
      className={[
        "session-progress",
        compact && "is-compact",
        legend && "has-legend",
        done && "is-done",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      title={total ? `${triaged} of ${total} sorted` : "No media to triage yet"}
    >
      {legend ? (
        <>
          <div className="session-progress-row">
            {track}
            {label}
          </div>
          <div className="session-progress-legend">
            <span>
              <i className="is-pick" aria-hidden />
              {picks} {picks === 1 ? "pick" : "picks"}
            </span>
            <span>
              <i className="is-reject" aria-hidden />
              {rejects} {rejects === 1 ? "reject" : "rejects"}
            </span>
            {skips > 0 && (
              <span>
                <i className="is-skip" aria-hidden />
                {skips} skipped
              </span>
            )}
            <span>
              <i className="is-todo" aria-hidden />
              {total === 0 ? "nothing to sort" : done ? "sorted" : `${unrated} to sort`}
            </span>
          </div>
        </>
      ) : (
        <>
          {track}
          {label}
        </>
      )}
    </div>
  );
}
