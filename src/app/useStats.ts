"use client";

// Shared access to the pipeline counters served by GET /api/stats — used by
// both the Pipeline page (full control panel + detailed bento) and the compact
// stats strip in the Library header. Keeps a single source of truth for the
// Stats shape and the small derivations on top of it.
import { useCallback, useEffect, useState } from "react";
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
  };
  queues: {
    scan: QueueCounts;
    analyze: QueueCounts;
    import: QueueCounts;
    paused: boolean;
  } | null;
  paused: boolean;
  settings: { scanPerHour: number; analyzePerHour: number };
  failures?: { derivative: number; scan: number; import: number };
};

// Active work in a queue = in progress + pending (prioritized included).
export function active(c: QueueCounts | undefined): number {
  if (!c) return 0;
  return (c.active ?? 0) + (c.waiting ?? 0) + (c.prioritized ?? 0);
}

// Sum of every failure family surfaced by /api/stats.
export function totalFailures(s: Stats | null): number {
  const f = s?.failures;
  return (f?.derivative ?? 0) + (f?.scan ?? 0) + (f?.import ?? 0);
}

// Polls /api/stats on an interval (default 5 s). A transient fetch error keeps
// the last good snapshot rather than blanking the UI.
export function useStats(intervalMs = 5000): {
  stats: Stats | null;
  reload: () => Promise<void>;
} {
  const [stats, setStats] = useState<Stats | null>(null);
  const reload = useCallback(async () => {
    try {
      setStats(await fetchJson<Stats>("/api/stats"));
    } catch {
      /* transient: keep the current snapshot */
    }
  }, []);
  useEffect(() => {
    reload();
    const t = setInterval(reload, intervalMs);
    return () => clearInterval(t);
  }, [reload, intervalMs]);
  return { stats, reload };
}
