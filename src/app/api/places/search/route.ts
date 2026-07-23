// GET /api/places/search?q=… -> place-name suggestions for the geotag
// autocomplete (forward geocoding). Thin proxy over the configured
// Nominatim-compatible provider (cf. lib/geocode.ts searchPlaces) — the browser
// never talks to the provider directly, so the User-Agent/email policy settings
// and the shared rate budget all apply here too. Returns 429 when that budget
// is momentarily drunk dry by a reverse-geocode backfill.
import { NextRequest } from "next/server";
import { searchPlaces, GeocodeRateLimited } from "@/lib/geocode";
import { config } from "@/lib/config";
import { json, badRequest, serverError } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    if (!config.geocode.enabled)
      return badRequest("geocoding is disabled (GEOCODE_ENABLED=false)");
    const query = req.nextUrl.searchParams.get("q")?.trim() ?? "";
    if (!query) return json({ results: [] });
    const results = await searchPlaces(query);
    return json({ results });
  } catch (err) {
    if (err instanceof GeocodeRateLimited) {
      return json({ error: err.message }, 429);
    }
    return serverError(err);
  }
}
