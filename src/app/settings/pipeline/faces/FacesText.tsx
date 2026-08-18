"use client";

// Settings › Pipeline › Faces & text — the triage surface for the ML analysis
// stage (face detection + OCR, cf. lib/ml.ts), mirroring what Media/Pending do
// for derivatives:
//   • an ml_status facet with live counts — "Pending" is the media still
//     missing an analysis, "Error" what failed (with the message inline),
//   • the same reusable browser (list / grid / folder + viewer) showing each
//     item's result (face count · text) with per-row actions: View, Download,
//     Analyze (re-queue the ML job) and Delete,
//   • a Jobs panel over the ml queue (active / queued / past runs), and
//   • the "Analyze missing" backfill (same endpoint as the Pipeline overview).
import { useEffect, useState } from "react";
import PipelineAssetList from "../PipelineAssetList";
import MlQueuePanel from "../MlQueuePanel";
import { EmptyState, Icons } from "../../../ui";
import { useStats } from "../../../useStats";

type Panel = "media" | "jobs";

// The ml_status facet. Same shape as the Media page's derivative facet: each key
// maps to a query fragment for /api/assets; `all` adds nothing.
type StatusKey = "all" | "ready" | "pending" | "error" | "skipped";
const STATUS_ORDER: StatusKey[] = ["all", "ready", "pending", "error", "skipped"];
const STATUS_LABEL: Record<StatusKey, string> = {
  all: "All",
  ready: "Analyzed",
  pending: "Pending",
  error: "Error",
  skipped: "Skipped",
};
const STATUS_QS: Record<StatusKey, string> = {
  all: "",
  ready: "ml_status=ready",
  pending: "ml_status=pending,processing",
  error: "ml_status=error",
  skipped: "ml_status=skipped",
};
const STATUS_HINT: Record<StatusKey, string> = {
  all: "Every indexed media with its ML analysis state and result (faces · text).",
  ready:
    "Media the analysis has been run on — each row shows how many faces were detected and whether text was read.",
  pending:
    "Media still missing a faces/text analysis (never analyzed, or re-queued). They drain through the ML queue at the Faces/OCR rate — or queue them all with “Analyze missing”.",
  error:
    "Media whose ML analysis failed — usually the ML container being unreachable, too old for a requested task, or timing out. The message is shown on each row; fix the cause, then Analyze to retry.",
  skipped:
    "Media taken out of the ML pipeline (their derivative is in error/skipped, so there is nothing to analyze). Regenerate the derivative from Media to make them analyzable again.",
};

export default function FacesTextPage() {
  const { stats, reload } = useStats();
  const [panel, setPanel] = useState<Panel>("media");
  const [status, setStatus] = useState<StatusKey>("all");
  // ML/search-index backfill (same one-click action as the Pipeline overview).
  const [mlBusy, setMlBusy] = useState(false);
  const [mlMsg, setMlMsg] = useState<string | null>(null);

  // Seed the facet from the URL (?status=pending) so the overview tile and the
  // nav badge can deep-link straight into "what's missing"; reflect changes back
  // so the view is shareable.
  useEffect(() => {
    try {
      const s = new URLSearchParams(window.location.search).get("status");
      if (s && STATUS_ORDER.includes(s as StatusKey)) setStatus(s as StatusKey);
    } catch {
      /* no window / bad URL: keep the default */
    }
  }, []);
  const pickStatus = (s: StatusKey) => {
    setStatus(s);
    try {
      const sp = new URLSearchParams(window.location.search);
      if (s === "all") sp.delete("status");
      else sp.set("status", s);
      const qs = sp.toString();
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${qs ? `?${qs}` : ""}`,
      );
    } catch {
      /* non-fatal: the in-memory facet still applies */
    }
  };

  async function runMlBackfill() {
    setMlBusy(true);
    setMlMsg(null);
    try {
      const res = await fetch("/api/pipeline/ml-backfill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = (await res.json().catch(() => ({}))) as {
        queued?: number;
        error?: string;
      };
      if (!res.ok) {
        setMlMsg(body.error ?? "Backfill failed");
      } else if (!body.queued) {
        setMlMsg("Everything is already analyzed.");
      } else {
        setMlMsg(
          `Queued ${body.queued.toLocaleString()} job(s) — drains at the Faces/OCR rate.`,
        );
        await reload();
      }
    } catch {
      setMlMsg("Backfill failed");
    } finally {
      setMlBusy(false);
    }
  }

  // The feature is off server-side: every counter would sit at 0 forever, so
  // explain instead of showing a stage that can never progress.
  if (stats && !stats.mlEnabled) {
    return (
      <div className="pl-section">
        <EmptyState
          icon={Icons.photoSearch}
          title="ML analysis is disabled"
          hint="Set ML_ENABLED=true (and point ML_BASE_URL at your machine-learning container) to detect faces and read text off the derivatives."
        />
      </div>
    );
  }

  const a = stats?.assets;
  const mlPct =
    a && a.total > 0
      ? Math.min(100, Math.round((a.ml_ready / a.total) * 100))
      : null;
  const count: Record<StatusKey, number | undefined> = {
    all: a?.total,
    ready: a?.ml_ready,
    pending: a?.ml_pending,
    error: a?.ml_errors,
    skipped: a?.ml_skipped,
  };

  return (
    <div className="pl-section pl-ml">
      <div className="filterbar pl-toolbar">
        <div className="view-toggle" role="group" aria-label="Panel">
          <button
            className={`view-btn${panel === "media" ? " active" : ""}`}
            onClick={() => setPanel("media")}
            aria-pressed={panel === "media"}
            title="Browse the media and their analysis results"
          >
            {Icons.viewMedia}
            <span className="pl-view-label">Media</span>
          </button>
          <button
            className={`view-btn${panel === "jobs" ? " active" : ""}`}
            onClick={() => setPanel("jobs")}
            aria-pressed={panel === "jobs"}
            title="The ML queue: running, waiting and past analysis jobs"
          >
            {Icons.viewJobs}
            <span className="pl-view-label">Jobs</span>
          </button>
        </div>
        <span className="spacer" />
        <button
          className="btn btn-sm"
          onClick={runMlBackfill}
          disabled={mlBusy}
          title="Queue ML analysis for every media still missing faces/text or a search embedding (idempotent)"
        >
          {mlBusy ? "Queuing…" : "🔍 Analyze missing"}
        </button>
      </div>
      {mlMsg && <p className="hint">{mlMsg}</p>}

      {/* Coverage: analyzed vs the live library, same meter as Search index. */}
      {a && (
        <div className="pl-coverage">
          <div className="pl-coverage-row">
            <span>
              <strong>{a.ml_ready.toLocaleString()}</strong> of{" "}
              {a.total.toLocaleString()} media analyzed for faces & text
              {mlPct != null ? ` (${mlPct}%)` : ""}
            </span>
            <span className="spacer" />
            {a.ml_pending > 0 && (
              <span className="hint">{a.ml_pending.toLocaleString()} pending</span>
            )}
          </div>
          <div
            className="pl-meter"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={a.total}
            aria-valuenow={a.ml_ready}
            aria-label="Faces & text analysis coverage"
          >
            <div
              className={`pl-meter-fill${mlPct === 100 ? " ok" : ""}`}
              style={{ width: `${mlPct ?? 0}%` }}
            />
          </div>
        </div>
      )}

      {panel === "jobs" ? (
        <MlQueuePanel />
      ) : (
        <>
          <div className="chips pl-status">
            {STATUS_ORDER.map((s) => (
              <button
                key={s}
                className={`chip${status === s ? " active" : ""}`}
                onClick={() => pickStatus(s)}
                aria-pressed={status === s}
              >
                {STATUS_LABEL[s]}
                {count[s] != null && (
                  <span className="chip-count">{count[s]!.toLocaleString()}</span>
                )}
              </button>
            ))}
          </div>

          <PipelineAssetList
            key={status}
            query={STATUS_QS[status]}
            actions={["view", "download", "analyze", "delete"]}
            views={["list", "grid", "folder"]}
            showMl
            defaultSort={{ field: "processed", dir: "desc" }}
            hint={STATUS_HINT[status]}
            emptyTitle={
              status === "pending"
                ? "Nothing left to analyze"
                : status === "error"
                  ? "No analysis failures"
                  : "Nothing here"
            }
            emptyHint={
              status === "pending"
                ? "Every analyzable media has been through the ML stage. 🎉"
                : undefined
            }
          />
        </>
      )}
    </div>
  );
}
