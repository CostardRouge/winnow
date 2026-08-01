"use client";

// Settings › Pipeline › Search index — the triage surface for the semantic
// search index (CLIP embeddings, cf. lib/ml.ts): how much of the library the
// search actually ranks over, and the gap.
//   • a coverage meter (indexed vs library, under the CURRENT model),
//   • a facet over the index: "Missing" is the media semantic search cannot
//     see yet, "Indexed" the pool it ranks,
//   • the same reusable browser (list / grid / folder + viewer) with per-row
//     actions: View, Download and Analyze (re-queue the ML job — the embedding
//     rides the same run as faces/OCR),
//   • a Jobs panel over the ml queue, and the "Index for search" backfill.
import { useEffect, useState } from "react";
import PipelineAssetList from "../PipelineAssetList";
import MlQueuePanel from "../MlQueuePanel";
import { EmptyState, Icons } from "../../../ui";
import { useStats } from "../../../useStats";

type Panel = "media" | "jobs";

// The index facet: membership of asset_clip under the current model.
type IndexKey = "missing" | "indexed" | "all";
const INDEX_ORDER: IndexKey[] = ["missing", "indexed", "all"];
const INDEX_LABEL: Record<IndexKey, string> = {
  missing: "Missing",
  indexed: "Indexed",
  all: "All",
};
const INDEX_QS: Record<IndexKey, string> = {
  missing: "clip_indexed=0",
  indexed: "clip_indexed=1",
  all: "",
};
const INDEX_HINT: Record<IndexKey, string> = {
  missing:
    "Media without a search embedding under the current model — semantic search can’t rank them yet. Analyze one item to index it now, or queue them all with “Index for search” (they drain at the Faces/OCR rate). Media without a derivative can’t be indexed until it’s generated.",
  indexed:
    "The pool semantic search ranks: media with a CLIP embedding under the current model. Analyze re-computes an embedding (e.g. after a model change).",
  all: "Every indexed media, whether or not it’s in the search index yet.",
};

export default function SearchIndexPage() {
  const { stats, reload } = useStats();
  const [panel, setPanel] = useState<Panel>("media");
  const [facet, setFacet] = useState<IndexKey>("missing");
  const [mlBusy, setMlBusy] = useState(false);
  const [mlMsg, setMlMsg] = useState<string | null>(null);

  // Seed the facet from the URL (?index=indexed) and reflect it back, so the
  // overview tile / nav can deep-link and the view stays shareable.
  useEffect(() => {
    try {
      const s = new URLSearchParams(window.location.search).get("index");
      if (s && INDEX_ORDER.includes(s as IndexKey)) setFacet(s as IndexKey);
    } catch {
      /* no window / bad URL: keep the default */
    }
  }, []);
  const pickFacet = (s: IndexKey) => {
    setFacet(s);
    try {
      const sp = new URLSearchParams(window.location.search);
      if (s === "missing") sp.delete("index");
      else sp.set("index", s);
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
        setMlMsg("Everything is already indexed.");
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

  // Semantic search is off server-side: explain instead of an index that can
  // never fill.
  if (stats && (!stats.mlEnabled || !stats.clipEnabled)) {
    return (
      <div className="pl-section">
        <EmptyState
          icon={Icons.photoSearch}
          title="Semantic search is disabled"
          hint="Set ML_ENABLED=true and ML_CLIP_ENABLED=true (with ML_BASE_URL pointing at your machine-learning container) to build the search index."
        />
      </div>
    );
  }

  // CLIP is on but there is nowhere to store embeddings (pgvector isn't
  // installed, so migration 0030 skipped the asset_clip table). "0 of N missing
  // → backfill" would be a lie here; say what's actually wrong.
  if (stats && stats.clipEnabled && !stats.clip) {
    return (
      <div className="pl-section">
        <EmptyState
          icon={Icons.photoSearch}
          title="Search index unavailable"
          hint="Semantic search is enabled but the pgvector extension isn't installed in Postgres, so there is nowhere to store the embeddings. Install pgvector (CREATE EXTENSION vector) and re-run the migrations."
        />
      </div>
    );
  }

  const clip = stats?.clip;
  const missing = clip ? Math.max(0, clip.library - clip.indexed) : undefined;
  const pct =
    clip && clip.library > 0
      ? Math.min(100, Math.round((clip.indexed / clip.library) * 100))
      : null;
  const count: Record<IndexKey, number | undefined> = {
    missing,
    indexed: clip?.indexed,
    all: clip?.library,
  };

  return (
    <div className="pl-section pl-ml">
      <div className="filterbar pl-toolbar">
        <div className="view-toggle" role="group" aria-label="Panel">
          <button
            className={`view-btn${panel === "media" ? " active" : ""}`}
            onClick={() => setPanel("media")}
            aria-pressed={panel === "media"}
            title="Browse the media by index membership"
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
          title="Queue ML analysis for every media still missing a search embedding (idempotent)"
        >
          {mlBusy ? "Queuing…" : "🔍 Index for search"}
        </button>
      </div>
      {mlMsg && <p className="hint">{mlMsg}</p>}

      {/* Coverage: the pool the search ranks vs the searchable library. */}
      {clip && (
        <div className="pl-coverage">
          <div className="pl-coverage-row">
            <span>
              <strong>{clip.indexed.toLocaleString()}</strong> of{" "}
              {clip.library.toLocaleString()} media indexed for search
              {pct != null ? ` (${pct}%)` : ""}
            </span>
            <span className="spacer" />
            {missing != null && missing > 0 && (
              <span className="hint">
                {missing.toLocaleString()} missing
              </span>
            )}
          </div>
          <div
            className="pl-meter"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={clip.library}
            aria-valuenow={clip.indexed}
            aria-label="Search-index coverage"
          >
            <div
              className={`pl-meter-fill${pct === 100 ? " ok" : ""}`}
              style={{ width: `${pct ?? 0}%` }}
            />
          </div>
        </div>
      )}

      {panel === "jobs" ? (
        <MlQueuePanel />
      ) : (
        <>
          <div className="chips pl-status">
            {INDEX_ORDER.map((s) => (
              <button
                key={s}
                className={`chip${facet === s ? " active" : ""}`}
                onClick={() => pickFacet(s)}
                aria-pressed={facet === s}
              >
                {INDEX_LABEL[s]}
                {count[s] != null && (
                  <span className="chip-count">{count[s]!.toLocaleString()}</span>
                )}
              </button>
            ))}
          </div>

          <PipelineAssetList
            key={facet}
            query={INDEX_QS[facet]}
            actions={["view", "download", "analyze"]}
            views={["list", "grid", "folder"]}
            showMl
            defaultSort={{ field: "processed", dir: "desc" }}
            hint={INDEX_HINT[facet]}
            emptyTitle={
              facet === "missing" ? "The index is complete" : "Nothing here"
            }
            emptyHint={
              facet === "missing"
                ? "Every media has a search embedding under the current model — semantic search sees the whole library. 🎉"
                : undefined
            }
          />
        </>
      )}
    </div>
  );
}
