"use client";

// Shared access to the pipeline counters served by GET /api/stats — used by
// both the Pipeline page (full control panel + detailed bento) and the compact
// stats strip in the Library header. Keeps a single source of truth for the
// Stats shape and the small derivations on top of it.
import { useEffect, useState } from "react";
import { fetchJson } from "@/lib/fetchJson";

export type QueueCounts = Record<string, number>;

export type Stats = {
  assets: {
    total: number;
    photos: number;
    videos: number;
    analyzed: number;
    pending: number;
    errors: number;
    skipped: number;
    // ML analysis (faces + OCR, cf. lib/ml.ts).
    ml_ready: number;
    ml_pending: number;
    ml_errors: number;
    ml_skipped: number;
  };
  queues: {
    scan: QueueCounts;
    analyze: QueueCounts;
    import: QueueCounts;
    ml?: QueueCounts;
    paused: boolean;
  } | null;
  paused: boolean;
  settings: {
    scanPerHour: number;
    analyzePerHour: number;
    mlPerHour: number;
    // Periodic re-scan interval (minutes, 0 = off) — cf. worker.ts.
    rescanMinutes: number;
  };
  // Whether the ML analysis feature is configured on the server (ML_ENABLED):
  // gates the ML slider/counters so a stage that can't progress isn't shown.
  mlEnabled?: boolean;
  // Semantic search (ML_CLIP_ENABLED) + its index coverage: media with a CLIP
  // embedding under the current model vs the searchable library.
  clipEnabled?: boolean;
  clip?: { indexed: number; library: number } | null;
  failures?: {
    derivative: number;
    scan: number;
    import: number;
    ml?: number;
    duplicates?: number;
    // Originals gone from disk, awaiting restore/purge triage (lib/integrity.ts).
    missing?: number;
  };
};

// Active work in a queue = in progress + pending (prioritized included).
export function active(c: QueueCounts | undefined): number {
  if (!c) return 0;
  return (c.active ?? 0) + (c.waiting ?? 0) + (c.prioritized ?? 0);
}

// Sum of every failure family surfaced by /api/stats. Mirrors the tabs on
// /pipeline/failures — deduplication included — so the aggregate badge stays in
// sync with the subsections and drops as duplicates are resolved.
export function totalFailures(s: Stats | null): number {
  const f = s?.failures;
  return (
    (f?.derivative ?? 0) +
    (f?.scan ?? 0) +
    (f?.import ?? 0) +
    (f?.ml ?? 0) +
    (f?.duplicates ?? 0) +
    (f?.missing ?? 0)
  );
}

// One shared /api/stats poll for the whole app. Several components display
// these counters at once (the pipeline tabs, the control panel, the Library
// stats strip…); each keeping its own 5 s interval meant N identical requests
// per tick. Instead a single module-level store polls while at least one
// component subscribes, and every subscriber renders from the same snapshot.
const POLL_MS = 5000;
let snapshot: Stats | null = null;
let inflight: Promise<void> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const subscribers = new Set<(s: Stats) => void>();

// A transient fetch error keeps the last good snapshot rather than blanking
// the UI. Concurrent callers (interval tick + a manual reload after an action)
// share the same request instead of stacking them.
function refresh(): Promise<void> {
  if (!inflight) {
    inflight = fetchJson<Stats>("/api/stats")
      .then((s) => {
        snapshot = s;
        subscribers.forEach((fn) => fn(s));
      })
      .catch(() => {
        /* transient: keep the current snapshot */
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

function subscribe(fn: (s: Stats) => void): () => void {
  subscribers.add(fn);
  if (subscribers.size === 1) {
    void refresh();
    timer = setInterval(refresh, POLL_MS);
  }
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

// Subscribe to the shared poll. `reload` forces an immediate refresh (e.g.
// right after pause/resume or a settings change) — the new snapshot reaches
// every subscribed component, not just the caller.
export function useStats(): {
  stats: Stats | null;
  reload: () => Promise<void>;
} {
  const [stats, setStats] = useState<Stats | null>(snapshot);
  useEffect(() => {
    // Catch up on a snapshot that landed between render and subscription.
    setStats(snapshot);
    return subscribe(setStats);
  }, []);
  return { stats, reload: refresh };
}
