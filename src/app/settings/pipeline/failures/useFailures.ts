"use client";

// Data + actions shared by every failure-family page: the /api/failures poll
// (5 s, keeping the last snapshot through transient errors) and the retry
// plumbing with its per-action busy key (e.g. "scan:all", "derivative:one:42")
// so a single button spins while the rest are disabled to prevent
// double-submits. Only one family page is mounted at a time, so each page
// owning its own poll costs one request per tick, same as before the split.
import { useCallback, useEffect, useState } from "react";
import { fetchJson } from "@/lib/fetchJson";
import type { Failures, Kind, Scope } from "./model";

export function useFailures() {
  const [data, setData] = useState<Failures | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string>("");

  const load = useCallback(async () => {
    try {
      setData(await fetchJson<Failures>("/api/failures"));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const doRetry = useCallback(
    async (kind: Kind, scope: Scope, busyKey: string) => {
      if (busy) return;
      setBusy(busyKey);
      setMsg("");
      try {
        const r = await fetch("/api/failures/retry", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind, ...scope }),
        });
        const d = await r.json();
        setMsg(
          r.ok
            ? `Re-queued ${kind} (${d.retried ?? 0}). Watch the counts drop as it reprocesses.`
            : `Error: ${d.error ?? "unknown"}`,
        );
        await load();
      } finally {
        setBusy(null);
      }
    },
    [busy, load],
  );

  return { data, error, busy, setBusy, msg, setMsg, load, doRetry };
}

export type FailuresState = ReturnType<typeof useFailures>;
