"use client";

// The feature flags, handed down from the root layout to every client
// component that has to decide whether to draw an entry point.
//
// The flags are read from Postgres in `layout.tsx` (a server component) and
// passed through this context rather than fetched again from the browser: an
// entry point that appears a beat after the page paints is worse than one that
// was never there, and `NEXT_PUBLIC_*` could not carry them anyway (inlined at
// build time — cf. the header of `src/lib/features.ts`).
//
// ## Why this holds state instead of just passing the prop through
//
// **`router.refresh()` does not re-render the root layout.** Measured: after
// PATCH /api/features the Settings pane called `router.refresh()`, the route's
// own server components re-rendered, and the rail did not move until a full
// page load. So a switch that only writes to the database looks broken for as
// long as you stay on the page.
//
// The fix is to let this provider own the live copy: seeded from the server on
// every full load, re-seeded whenever the server value actually changes (a
// navigation that did re-render the layout), and updated directly by whoever
// flipped a flag through `useSetFeatures()`. The server stays the source of
// truth — this is a mirror of it, never a second one.
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { FEATURE_DEFAULTS, type Features } from "@/lib/features";

// The default is the registry's own defaults, so a component rendered outside
// the provider (a stray tree, a test) degrades to "the instance's defaults"
// rather than to "everything is off".
const FeaturesContext = createContext<Features>(FEATURE_DEFAULTS);
const SetFeaturesContext = createContext<(next: Features) => void>(() => {});

export function FeaturesProvider({
  value,
  children,
}: {
  value: Features;
  children: React.ReactNode;
}) {
  const [features, setFeatures] = useState(value);

  // Re-seed from the server whenever it says something different. The
  // dependency is the serialized value, not the object: the layout builds a
  // fresh object on every render and comparing identities would loop.
  const serverValue = JSON.stringify(value);
  useEffect(() => {
    setFeatures(JSON.parse(serverValue) as Features);
  }, [serverValue]);

  const set = useMemo(() => (next: Features) => setFeatures(next), []);

  return (
    <FeaturesContext.Provider value={features}>
      <SetFeaturesContext.Provider value={set}>
        {children}
      </SetFeaturesContext.Provider>
    </FeaturesContext.Provider>
  );
}

export function useFeatures(): Features {
  return useContext(FeaturesContext);
}

/**
 * For the one screen that changes the flags (Settings › Features): hand it the
 * flags the server just confirmed, so the rail moves under your hand instead
 * of waiting for a full page load. Never call it with a guess — only with what
 * PATCH /api/features answered.
 */
export function useSetFeatures(): (next: Features) => void {
  return useContext(SetFeaturesContext);
}
