// GET   /api/features            -> the flags as they stand, plus the registry
//                                   (label/blurb/caveat) so the Settings pane
//                                   never drifts from src/lib/features.ts.
// PATCH /api/features { <id>: boolean, ... } -> flips one or more flags.
//
// Deliberately NOT part of /api/settings: that one is the contract shared with
// the workers (pause, hourly rates, pairing), and no worker cares whether the
// Gear shelf is on screen. Cf. the header of src/lib/features.ts.
//
// Reading is viewer-visible (the rail already tells you what exists); writing
// is admin, via the /api/features prefix in lib/authz.ts.
import { NextRequest } from "next/server";
import { z } from "zod";
import { FEATURES, type Features } from "@/lib/features";
import { getFeatures, setFeatures } from "@/lib/featureGate";
import { json, badRequest, serverError } from "@/lib/api";

// DB-backed route: never pre-rendered/cached at build time.
export const dynamic = "force-dynamic";

// One optional boolean per registered flag — built from the registry so adding
// a feature needs no second edit here.
const Body = z.object(
  Object.fromEntries(FEATURES.map((f) => [f.id, z.boolean().optional()])),
) as z.ZodType<Partial<Features>>;

export async function GET() {
  try {
    return json({
      features: await getFeatures(true),
      registry: FEATURES.map(({ id, label, blurb, caveat, enabled }) => ({
        id,
        label,
        blurb,
        caveat,
        default: enabled,
      })),
    });
  } catch (err) {
    return serverError(err);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success)
      return badRequest("invalid features", parsed.error.issues);
    return json({ features: await setFeatures(parsed.data) });
  } catch (err) {
    return serverError(err);
  }
}
