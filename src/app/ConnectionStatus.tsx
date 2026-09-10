"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

// Connection status — a slim pill at the top of the viewport, not a takeover.
//
// public/offline.html is the service worker's answer to a *navigation* that
// cannot reach the network: it replaces the whole document, so it costs you
// your scroll position, your selection and the frame you were judging. That is
// the right screen for a cold start with an empty cache and the wrong one for
// "the tunnel blinked while I was culling" — the case that actually happens.
// This component covers that case instead: it says what is wrong, offers the
// one useful verb, and leaves the page you were on exactly where it was.
//
// How it notices, in order of cost:
//   1. `offline`/`online` — free, but only fires when the DEVICE loses its
//      network. Winnow's real failure mode is the opposite: wifi is fine and
//      the Optiplex is not answering (a Watchtower redeploy, the tunnel, a
//      Postgres restart), and the browser reports that as online.
//   2. A rejected `fetch` — every screen here is fed by one, so a dead server
//      surfaces within a second of the first failed call. Observing the global
//      `fetch` costs nothing while things work, which is why there is no
//      background poll: a healthy session sends zero extra requests.
//   3. A probe of /api/health, which is what actually decides. (1) and (2) only
//      raise the question; nothing is shown until the probe fails too, so a
//      one-off aborted request or a CORS error never flashes a false alarm.
// While down, the probe is the retry loop — it is the same request either way.

/** Public (lib/authz.ts), tiny, and never cached by the worker (public/sw.js). */
const PROBE_PATH = "/api/health";
/** A probe that hangs is a failed probe; the tunnel drops connections silently. */
const PROBE_TIMEOUT_MS = 6000;
/** Eager at first (a redeploy is back in seconds), patient after (an outage isn't). */
const BACKOFF_MS = [2000, 4000, 8000, 15000, 30000];
/** How long "Back online" lingers before the bar leaves on its own. */
const RECOVERED_MS = 5000;

type Bar = { tone: "down" | "back"; label: string };

export default function ConnectionStatus() {
  const [bar, setBar] = useState<Bar | null>(null);
  const [checking, setChecking] = useState(false);
  // The button needs the effect's `check`; the effect owns all mutable state as
  // plain locals (no ref gymnastics, no stale closures), so it hands the one
  // callback the render needs back through this ref.
  const retryRef = useRef<() => void>(() => {});

  useEffect(() => {
    let alive = true;
    let down = false;
    let attempt = 0;
    let inFlight = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let leaveTimer: ReturnType<typeof setTimeout> | null = null;
    // Captured before the patch below, and used for the probe itself: a failing
    // probe must not be read as "a fetch failed" and schedule another check.
    const originalFetch = window.fetch;
    const rawFetch = (input: RequestInfo | URL, init?: RequestInit) =>
      originalFetch.call(window, input, init);

    // Read through a call, never inline: an inline `navigator.onLine === false`
    // narrows the property to `true` for the rest of the block, and tsc then
    // rejects the second reading (after the await) as a dead comparison — which
    // is exactly the reading that matters, since the radio may have dropped
    // while the probe was in flight.
    const noNetwork = () => navigator.onLine === false;

    const clearRetry = () => {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
    };

    const scheduleRetry = () => {
      clearRetry();
      const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
      attempt += 1;
      // A hidden tab does not probe: `visibilitychange` below picks it back up,
      // so a phone in a pocket is not retrying a dead host every 30 seconds.
      retryTimer = setTimeout(() => {
        if (document.hidden) return;
        void check();
      }, wait);
    };

    const fail = (label: string) => {
      if (!alive) return;
      down = true;
      if (leaveTimer) clearTimeout(leaveTimer);
      leaveTimer = null;
      setBar({ tone: "down", label });
      scheduleRetry();
    };

    const succeed = () => {
      if (!alive) return;
      clearRetry();
      attempt = 0;
      if (!down) {
        setBar(null);
        return;
      }
      down = false;
      // Say so, and offer the reload: everything on screen was fetched before
      // the outage, so the view is right about the past and not the present.
      setBar({ tone: "back", label: "Back online" });
      leaveTimer = setTimeout(() => {
        if (alive) setBar(null);
      }, RECOVERED_MS);
    };

    const check = async () => {
      if (!alive || inFlight) return;
      // The browser is authoritative when it says there is no network at all —
      // the probe cannot succeed, so skip it and keep the loop running.
      if (noNetwork()) {
        fail("You're offline");
        return;
      }
      inFlight = true;
      setChecking(true);
      const ctrl = new AbortController();
      const kill = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
      try {
        const res = await rawFetch(PROBE_PATH, {
          cache: "no-store",
          signal: ctrl.signal,
        });
        // 503 = the app answered but Postgres or Redis did not. Worth naming:
        // "can't reach Winnow" would send you looking at the wrong box, and
        // this is what a restart looks like for the few seconds it takes.
        // One short clause per case, never a list — the bar is one line on a
        // phone and a truncated sentence tells you less than a vaguer one.
        if (res.status === 503) {
          const body = (await res.json().catch(() => null)) as {
            db?: string;
            redis?: string;
          } | null;
          const db = body?.db === "down";
          const queue = body?.redis === "down";
          if (db && !queue) fail("Winnow's database is down");
          else if (queue && !db) fail("Winnow's queue is down");
          else fail("Winnow isn't ready yet");
        } else {
          succeed();
        }
      } catch {
        fail(noNetwork() ? "You're offline" : "Can't reach Winnow");
      } finally {
        clearTimeout(kill);
        inFlight = false;
        if (alive) setChecking(false);
      }
    };

    retryRef.current = () => {
      attempt = 0;
      void check();
    };

    // Observe, never intercept: the response and the rejection both travel on
    // untouched. Only a TypeError is a network failure — an AbortError is the
    // app cancelling its own request (every list here does that on unmount),
    // and anything else already got an HTTP answer from somewhere.
    const observed: typeof window.fetch = (input, init) =>
      originalFetch.call(window, input, init).then(
        (res) => res,
        (err: unknown) => {
          if (!down && err instanceof TypeError) void check();
          throw err;
        },
      );
    window.fetch = observed;

    const onOffline = () => fail("You're offline");
    const onOnline = () => {
      attempt = 0;
      void check();
    };
    const onVisible = () => {
      if (!document.hidden && down) void check();
    };
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);

    // No probe on mount — a healthy load must not pay for an extra request.
    if (noNetwork()) fail("You're offline");

    return () => {
      alive = false;
      clearRetry();
      if (leaveTimer) clearTimeout(leaveTimer);
      // Only if it is still ours: another patcher may have wrapped us since.
      if (window.fetch === observed) window.fetch = originalFetch;
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (!bar) return null;

  const back = bar.tone === "back";
  return (
    <div
      className={cn("conn-bar", back && "is-back", checking && "is-checking")}
      role="status"
      aria-live="polite"
    >
      <span className="conn-dot" aria-hidden />
      <span className="conn-text">{bar.label}</span>
      {back ? (
        <button
          type="button"
          className="btn btn-sm conn-act"
          onClick={() => location.reload()}
          title="Reload to refresh what's on screen"
        >
          Reload
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-sm conn-act"
          onClick={() => retryRef.current()}
          disabled={checking}
        >
          {checking ? "Checking…" : "Retry"}
        </button>
      )}
    </div>
  );
}
