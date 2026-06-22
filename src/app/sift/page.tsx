"use client";

// Sift — the fast-triage hub, built for the phone. It answers one question at a
// glance: "where did I leave off, and what's still to sort?" A resume card jumps
// straight back into the session you touched most recently, a shortcut isolates
// everything still incomplete, and the list can be ranked by recent activity,
// capture date or completeness. Tapping a session drops you into the swipe deck.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { fetchJson } from "@/lib/fetchJson";
import { EmptyState, Icons, LazyImage, SkeletonCards } from "@/app/ui";
import PullToRefresh from "@/app/PullToRefresh";
import SessionProgress from "@/app/sessions/SessionProgress";
import { formatRelativeTime } from "@/lib/format";

type SampleAsset = { id: number; ext: string; media_type: "photo" | "video" };

type SessionRow = {
  id: number;
  name: string;
  device_hint: string | null;
  asset_count: number;
  ignored: boolean;
  completed: boolean;
  pick_count: number | string;
  reject_count: number | string;
  unrated_count: number | string;
  ready_count: number | string;
  last_reviewed_at: string | null;
  sample_assets: SampleAsset[];
};

const num = (v: number | string | null | undefined) => Number(v) || 0;
const triageTotal = (s: SessionRow) =>
  num(s.pick_count) + num(s.reject_count) + num(s.unrated_count);

// Sort keys exposed in the toolbar → the API's `sort` param.
const SORTS: { key: string; label: string }[] = [
  { key: "touched", label: "Recent edits" },
  { key: "captured", label: "Capture date" },
  { key: "progress", label: "Completion" },
];

// Progress shortcuts → the API's `progress` param.
const FILTERS: { key: string; label: string }[] = [
  { key: "incomplete", label: "To sort" },
  { key: "untouched", label: "Untouched" },
  { key: "complete", label: "Done" },
  { key: "", label: "All" },
];

export default function SiftHub() {
  const [sort, setSort] = useState("touched");
  const [dir, setDir] = useState<"desc" | "asc">("desc");
  const [progress, setProgress] = useState("incomplete");
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [resume, setResume] = useState<SessionRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchJson<{ sessions?: SessionRow[] }>(
        `/api/sessions?kind=incoming&sort=${sort}&sort_dir=${dir}${progress ? `&progress=${progress}` : ""}`,
      );
      setSessions(data.sessions ?? []);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
      setSessions([]);
    }
  }, [sort, dir, progress]);

  useEffect(() => {
    load();
  }, [load]);

  // The "resume" card is pinned independent of the chosen sort: the most
  // recently triaged session that still has work left.
  useEffect(() => {
    let off = false;
    fetchJson<{ sessions?: SessionRow[] }>(
      "/api/sessions?kind=incoming&progress=incomplete&sort=touched&sort_dir=desc",
    )
      .then((d) => {
        if (off) return;
        const first = (d.sessions ?? []).find((s) => s.last_reviewed_at);
        setResume(first ?? (d.sessions ?? [])[0] ?? null);
      })
      .catch(() => {});
    return () => {
      off = true;
    };
  }, []);

  // Quick headline: how many sessions still need sorting (independent of the
  // list's current filter, so it's a stable "backlog" number).
  const toSort = useMemo(
    () => (sessions ?? []).filter((s) => num(s.unrated_count) > 0),
    [sessions],
  );

  return (
    <div className="app-shell sift-hub">
      <div className="topbar">
        <h1 className="sift-hub-title">{Icons.sift} Sift</h1>
        <span className="hint max-sm:hidden">swipe to triage — pick up where you left off</span>
        <span className="spacer" />
        <Link href="/library/incoming/sessions" className="btn">
          {Icons.viewList} <span className="max-sm:hidden">Sessions</span>
        </Link>
      </div>

      <PullToRefresh className="sift-hub-body" onRefresh={load}>
        {/* Resume — straight back into the deck you last worked on. */}
        {resume && progress !== "complete" && (
          <Link href={`/sift/${resume.id}`} className="sift-resume">
            <div className="sift-resume-cover">
              {resume.sample_assets?.[0] ? (
                <LazyImage src={`/api/assets/${resume.sample_assets[0].id}/thumb`} alt="" />
              ) : (
                <span className="sift-resume-cover-empty">{Icons.photos}</span>
              )}
            </div>
            <div className="sift-resume-info">
              <span className="sift-resume-kicker">
                {Icons.undo} Resume where you left off
              </span>
              <h2>{resume.name}</h2>
              <div className="sift-resume-meta">
                {num(resume.unrated_count)} to sort ·{" "}
                {resume.last_reviewed_at
                  ? `last touched ${formatRelativeTime(resume.last_reviewed_at)}`
                  : "not started yet"}
              </div>
              <SessionProgress
                picks={num(resume.pick_count)}
                rejects={num(resume.reject_count)}
                total={triageTotal(resume)}
              />
            </div>
            <span className="sift-resume-go btn btn-primary">{Icons.skipFwd}</span>
          </Link>
        )}

        {/* Controls: rank + direction + the progress shortcut. */}
        <div className="sift-controls">
          <div className="view-toggle" role="group" aria-label="Sort by">
            {SORTS.map((s) => (
              <button
                key={s.key}
                className={`view-btn${sort === s.key ? " active" : ""}`}
                onClick={() => setSort(s.key)}
                aria-pressed={sort === s.key}
              >
                {s.label}
              </button>
            ))}
          </div>
          <button
            className="icon-toggle"
            onClick={() => setDir((d) => (d === "desc" ? "asc" : "desc"))}
            title={dir === "desc" ? "Most first" : "Least first"}
            aria-label="Flip sort direction"
          >
            {dir === "desc" ? Icons.arrowDown : Icons.arrowUp}
          </button>
          <span className="spacer" />
          <div className="view-toggle" role="group" aria-label="Progress filter">
            {FILTERS.map((f) => (
              <button
                key={f.key || "all"}
                className={`view-btn${progress === f.key ? " active" : ""}`}
                onClick={() => setProgress(f.key)}
                aria-pressed={progress === f.key}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {progress === "incomplete" && sessions && (
          <div className="sift-count">
            {toSort.length === 0
              ? "All caught up — nothing left to sort."
              : `${toSort.length} session${toSort.length > 1 ? "s" : ""} still to sort`}
          </div>
        )}

        {error && (
          <div className="error-box">
            <span>Couldn’t load sessions: {error}</span>
            <button className="btn" onClick={load}>
              Retry
            </button>
          </div>
        )}

        {!sessions ? (
          <SkeletonCards rows={4} />
        ) : sessions.length === 0 ? (
          <EmptyState
            icon={Icons.sift}
            title="Nothing to sort here"
            hint="No sessions match this filter. Try “All”, or import some media to get going."
          >
            <Link href="/library/incoming/sessions" className="btn btn-primary">
              {Icons.viewList} Open sessions
            </Link>
          </EmptyState>
        ) : (
          <div className="sift-list">
            {sessions.map((s) => {
              const unrated = num(s.unrated_count);
              return (
                <div key={s.id} className="sift-tile">
                  <Link href={`/sift/${s.id}`} className="sift-tile-cover">
                    {s.sample_assets?.[0] ? (
                      <LazyImage src={`/api/assets/${s.sample_assets[0].id}/thumb`} alt="" />
                    ) : (
                      <span className="sift-tile-cover-empty">{Icons.photos}</span>
                    )}
                    {unrated === 0 && <span className="sift-tile-done">{Icons.keep}</span>}
                  </Link>
                  <div className="sift-tile-info">
                    <h3>
                      <Link href={`/sift/${s.id}`}>{s.name}</Link>
                    </h3>
                    <div className="sift-tile-meta">
                      {unrated > 0 ? `${unrated} to sort` : "all sorted"}
                      {s.last_reviewed_at ? ` · ${formatRelativeTime(s.last_reviewed_at)}` : ""}
                    </div>
                    <SessionProgress
                      picks={num(s.pick_count)}
                      rejects={num(s.reject_count)}
                      total={triageTotal(s)}
                      compact
                    />
                  </div>
                  <Link
                    href={`/sift/${s.id}`}
                    className={`btn sift-tile-go${unrated > 0 ? " btn-primary" : ""}`}
                    aria-label={`Sift ${s.name}`}
                  >
                    {Icons.sift}
                  </Link>
                </div>
              );
            })}
          </div>
        )}
      </PullToRefresh>
    </div>
  );
}
