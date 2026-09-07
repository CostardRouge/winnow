// Feature flags — which optional sections this instance offers.
//
// Winnow grew by verbs: sift, search, people, gear, timeline. Each one took a
// slot in the rail, and the rail is now the scarcest surface in the app. Some
// of those sections are also younger than the library they read — the Timeline
// most of all, which derives its chapters on every request and is being
// reworked. Atelier, the editing half of the stack, already stopped leaning on
// it for exactly that reason (its `shared/sources/winnow/features.ts` carries
// the argument: a mature tool must not depend on an immature one).
//
// A flag is the answer to both problems at once: it takes a section out of the
// rail when it is only clutter, and it takes an unfinished one out of reach
// entirely while it is being fixed.
//
// **The Library has no flag.** Browsing, culling and exporting the library is
// what the project *is*; everything else is built on top of it.
//
// ## Why the database and not the environment
//
// The flags live in `app_settings` under a single `features` row (a jsonb
// object), read through `getFeatures()` in `src/lib/featureGate.ts` — the
// server half, kept apart so THIS file stays importable from a client
// component (it reaches Postgres, and `pg` must never enter the browser
// bundle). Two reasons the flags are not an env var:
//
//   - `NEXT_PUBLIC_*` is inlined at `next build`, and the image is built in CI
//     (`.github/workflows/docker-build.yml`). A public env flag set in
//     `docker-compose-optiplex.yml` would simply never reach the browser
//     bundle — it would fail silently, which is the worst possible behaviour
//     for a switch whose whole job is to be visible. `src/app/mapTiles.ts`
//     already records this trap.
//   - The project's own rule, from `docs/memory/configuration.md`: what must
//     be tunable live lives in the database, what needs a restart lives in the
//     environment. Hiding a section is a matter of taste on a given day, not a
//     deployment decision, so it belongs in the database.
//
// ## Why its own row and not `AppSettings`
//
// `src/lib/settings.ts` is the source of truth *shared with the workers* —
// pause, hourly rates, pairing. No worker has any business knowing whether the
// Gear shelf is on screen, and widening `AppSettings` would put a UI concern in
// every worker's hot path. So this module owns its own row and its own cache,
// mirroring settings.ts's shape without importing it (which would also make
// the two files circular).

export type FeatureId =
  | "timeline"
  | "heatmap"
  | "sift"
  | "search"
  | "people"
  | "gear";

export type Features = Record<FeatureId, boolean>;

export type FeatureDescriptor = {
  id: FeatureId;
  /** The rail label, so the Settings pane and the rail never drift apart. */
  label: string;
  /** Whether the section is offered when nothing has been stored yet. */
  enabled: boolean;
  /** One line: what the section is, for someone deciding whether to keep it. */
  blurb: string;
  /** Stated only where the default is `false` — why it ships off. */
  caveat?: string;
};

// The registry. Adding a section to the rail means adding it here, adding the
// rail entry (`src/app/AppRail.tsx`), guarding its page with `requireFeature`
// and its own API routes with `featureOff`. The order is the rail's order.
export const FEATURES: readonly FeatureDescriptor[] = [
  {
    id: "timeline",
    label: "Timeline",
    // Off by default, and deliberately so: this is the one section whose
    // behaviour is not settled. Chapters are re-derived on every request, so
    // what a client reads today can change under it tomorrow; the cut rules,
    // the performance at library scale and the correction model all still owe
    // a rework. Turning it on is a choice to look at work in progress.
    enabled: false,
    blurb: "The library read as a story — chapters that cross session folders.",
    caveat:
      "Immature: chapters are re-derived on every request and the cut rules are still being reworked. Off until it settles.",
  },
  {
    id: "heatmap",
    label: "Heatmap",
    // Off by default: a step-back view of the whole library, not part of the
    // daily cull, and the rail is the scarcest surface in the app. Nothing
    // about it is unfinished — unlike the Timeline's caveat, this one is a
    // matter of whether you want the slot.
    enabled: false,
    blurb: "When and where the library was made — a calendar and a binned map on one measure.",
    caveat:
      "Off until you want the rail slot: it reads the whole library at once rather than the session in front of you.",
  },
  {
    id: "sift",
    label: "Sift",
    enabled: true,
    blurb: "The swipe deck — cull a session one frame at a time.",
  },
  {
    id: "search",
    label: "Search",
    enabled: true,
    blurb: "Keyword search across captions, OCR text and tags.",
  },
  {
    id: "people",
    label: "People",
    enabled: true,
    blurb: "Every person the face clustering found, one stack each.",
  },
  {
    id: "gear",
    label: "Gear",
    enabled: true,
    blurb: "The shelf of every body and lens the library was shot with.",
  },
];

export const FEATURE_DEFAULTS: Features = Object.freeze(
  Object.fromEntries(FEATURES.map((f) => [f.id, f.enabled])),
) as Features;

/**
 * A stored value → a complete `Features`. Unknown keys are dropped and missing
 * ones fall back to the descriptor's default, so adding a flag to the registry
 * never needs a migration of the stored row.
 */
export function parseFeatures(raw: unknown): Features {
  const value: Features = { ...FEATURE_DEFAULTS };
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const f of FEATURES) {
      const v = (raw as Record<string, unknown>)[f.id];
      if (typeof v === "boolean") value[f.id] = v;
    }
  }
  return value;
}

// The server half — reading, writing and the two guards — lives in
// `src/lib/featureGate.ts`, which imports this file. Keep the split: a client
// component reads `FEATURE_DEFAULTS` and `FeatureId` from here, and importing
// the gate would drag `pg` into the browser bundle (the build catches it, but
// only after the fact).
