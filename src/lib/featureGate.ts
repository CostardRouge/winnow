// The server half of the feature flags: reading them from Postgres, writing
// them back, and the two guards that make a flag mean something.
//
// Kept apart from `src/lib/features.ts` (the registry) because that one is
// imported by a client component — `src/app/FeaturesProvider.tsx` — and this
// one reaches the database. Importing the two together put `pg` in the browser
// bundle and broke the build; the split is what keeps that from coming back.
//
// Server-only, like `src/lib/config.ts`.
import { notFound } from "next/navigation";
import { many, q } from "./db";
import { notFound as notFoundJson } from "./api";
import {
  FEATURES,
  FEATURE_DEFAULTS,
  parseFeatures,
  type FeatureId,
  type Features,
} from "./features";

const KEY = "features";
const TTL_MS = 1500;
let cache: { value: Features; at: number } | null = null;

/**
 * The flags as they stand. Cached for a beat, like `getSettings()`: the root
 * layout reads this on every request, and the answer changes about once a
 * month.
 */
export async function getFeatures(force = false): Promise<Features> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.value;
  let value: Features = { ...FEATURE_DEFAULTS };
  try {
    const rows = await many<{ value: unknown }>(
      "SELECT value FROM app_settings WHERE key = $1",
      [KEY],
    );
    if (rows.length) value = parseFeatures(rows[0].value);
  } catch {
    // Postgres unavailable, or the table absent (before migration 0005): fall
    // back on the defaults rather than blanking the navigation. Failing OPEN
    // here is deliberate — a database blip must not make the app look broken —
    // and it is safe because a flag hides a section, it never guards data.
  }
  cache = { value, at: Date.now() };
  return value;
}

/** Flip one or more flags. Only ids in the registry are written. */
export async function setFeatures(patch: Partial<Features>): Promise<Features> {
  const next: Features = { ...(await getFeatures(true)) };
  for (const f of FEATURES) {
    const v = patch[f.id];
    if (typeof v === "boolean") next[f.id] = v;
  }
  await q(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [KEY, JSON.stringify(next)],
  );
  cache = null; // invalidate: the next read re-reads the DB
  return getFeatures(true);
}

/**
 * Page guard. A section that is off is not merely hidden from the rail — its
 * route answers 404, so a bookmark, a back button or a typed URL cannot reach
 * a feature the instance has decided not to offer.
 *
 * Server components only (it calls Next's `notFound()`).
 */
export async function requireFeature(id: FeatureId): Promise<void> {
  const features = await getFeatures();
  if (!features[id]) notFound();
}

/**
 * Route guard: the 404 an API answers when its feature is off, or `null` when
 * the route may proceed. Called at the top of a handler:
 *
 *     const off = await featureOff("timeline");
 *     if (off) return off;
 *
 * Applied ONLY to routes the feature owns outright. A route the rest of the
 * app also reads stays open even when its section is hidden — hiding the Gear
 * shelf must not empty the gallery's lens filter. Each gated route says at its
 * top why it belongs to its feature alone.
 */
export async function featureOff(id: FeatureId): Promise<Response | null> {
  const features = await getFeatures();
  if (features[id]) return null;
  return notFoundJson(`The "${id}" feature is disabled on this instance`);
}
