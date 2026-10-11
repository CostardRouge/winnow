"use client";

// The cleanup plan: the current view's duplicate groups split by WHO picks the
// survivor. Two cards are the two branches of the bulk rule (lib/duplicateList
// → autoKeep) — each prints its rule, its numbers and its own "Keep suggested"
// — and the third holds what no rule can decide. It replaces the single
// "Collapse N resolvable" button, which ran both branches at once over
// thousands of groups without saying which copy either would keep.
//
// The cards are also the list's filter ("Show"): the plan is counted before
// that filter, so every card keeps its number while the list shows one of them.
import { Icons } from "../../ui";
import { formatBytes } from "@/lib/format";
import type {
  DuplicateAutoRule,
  DuplicateFacet,
  DuplicatePlanKey,
} from "@/lib/duplicateTypes";

export const PLAN_CARDS: {
  key: DuplicatePlanKey;
  title: string;
  rule: string;
}[] = [
  {
    key: "protected",
    title: "View-only master + other copies",
    rule: "Keeps the copy on the Final/Export volume — already the library entry, or there is none. Deletes the other copies. Nothing is relinked.",
  },
  {
    key: "library",
    title: "Library entry + stray copies",
    rule: "Keeps the live library entry where it is. Deletes the other copies on disk (backups, “(copy)” folders, re-imports). Nothing is relinked.",
  },
  {
    key: "manual",
    title: "Needs you",
    rule: "No rule can pick the survivor: the library entry is in the trash, no copy is indexed, or a protected copy is not the library entry. Pick one per group.",
  },
];

/** What a finished bulk run did — a plan card's or a folder pair's. */
export type RunReport = {
  /** What ran: the card's title, or the pair's two folders. */
  title: string;
  resolved: number;
  deleted: number;
  relinked: number;
  failed: number;
  stopped: boolean;
  skipped: { reason: string; count: number }[];
};

export default function DedupPlan({
  plan,
  active,
  busy,
  report,
  onShow,
  onRun,
  onReview,
  onDismissReport,
}: {
  plan: Record<DuplicatePlanKey, DuplicateFacet>;
  active: DuplicatePlanKey | null;
  busy: boolean;
  report: RunReport | null;
  onShow: (key: DuplicatePlanKey | null) => void;
  onRun: (rule: DuplicateAutoRule) => void;
  /** Open the one-by-one review of the "Needs you" groups. */
  onReview: () => void;
  onDismissReport: () => void;
}) {
  return (
    <div className="dup-plan">
      <div className="dup-plan-cards">
        {PLAN_CARDS.map((card) => {
          const f = plan[card.key];
          const on = active === card.key;
          return (
            <article
              key={card.key}
              className={`dup-plan-card${on ? " is-active" : ""}${
                card.key === "manual" ? " is-manual" : ""
              }`}
            >
              <h4 className="dup-plan-title">{card.title}</h4>
              <p className="dup-plan-rule">{card.rule}</p>
              <p className="dup-plan-nums">
                <strong>{f.groups.toLocaleString()}</strong> group
                {f.groups === 1 ? "" : "s"} ·{" "}
                <strong>{Math.round(f.extras).toLocaleString()}</strong> extra cop
                {f.extras === 1 ? "y" : "ies"} ·{" "}
                <strong>{formatBytes(f.reclaimable)}</strong>
              </p>
              <div className="dup-plan-actions">
                <button
                  className="btn btn-sm"
                  aria-pressed={on}
                  disabled={!f.groups && !on}
                  onClick={() => onShow(on ? null : card.key)}
                >
                  {on ? "Show all" : "Show these"}
                </button>
                {card.key === "manual" && (
                  <button
                    className="btn btn-sm btn-primary"
                    disabled={busy || !f.groups}
                    onClick={onReview}
                    title="One group at a time, with the keyboard; nothing is deleted until you apply"
                  >
                    <span>Review one by one</span>
                  </button>
                )}
                {card.key !== "manual" && (
                  <button
                    className="btn btn-sm btn-danger"
                    disabled={busy || !f.groups}
                    onClick={() => onRun(card.key as DuplicateAutoRule)}
                    title="Keep the suggested copy in every group of this card, in the current view"
                  >
                    {Icons.keep}
                    <span>
                      Keep suggested in {f.groups.toLocaleString()} group
                      {f.groups === 1 ? "" : "s"}
                    </span>
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {/* Under the cards, not inside one: a long list of reasons must not
          stretch the whole row of cards. */}
      {report && <RunReportBox report={report} onDismiss={onDismissReport} />}
    </div>
  );
}

// The run's account of itself: what it did, and — grouped and counted — why it
// left groups behind. A refusal is never just a number (CODEBASE-AUDIT UX-05):
// the reason is what tells the user whether to rescan, fix a permission or move
// a file by hand.
export function RunReportBox({
  report,
  onDismiss,
}: {
  report: RunReport;
  onDismiss: () => void;
}) {
  const left = report.skipped.reduce((n, s) => n + s.count, 0);
  return (
    <div className="dup-run-report" role="status">
      <div className="dup-run-head">
        <span>
          <strong>{report.title}</strong>: kept one copy in{" "}
          <strong>{report.resolved.toLocaleString()}</strong> group
          {report.resolved === 1 ? "" : "s"}, deleting{" "}
          <strong>{report.deleted.toLocaleString()}</strong> file
          {report.deleted === 1 ? "" : "s"}.
          {report.stopped ? " Stopped early — the rest is untouched." : ""}
        </span>
        <button
          className="btn btn-sm btn-icon"
          onClick={onDismiss}
          aria-label="Dismiss the report"
          title="Dismiss"
        >
          {Icons.close}
        </button>
      </div>
      {left > 0 && (
        <details open={report.skipped.length <= 4}>
          <summary>
            {left.toLocaleString()} left in place — why
          </summary>
          <ul>
            {report.skipped.map((s) => (
              <li key={s.reason}>
                <strong>{s.count.toLocaleString()}</strong> · {s.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
