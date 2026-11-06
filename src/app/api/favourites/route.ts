// POST /api/favourites { ids[], favourite } → set or clear the ♥ on media
// (migration 0058, lib/favourites.ts). One route for the single gesture (the
// viewer's F, a tile's heart) and the bulk one (a selection, the favourites
// pass): a favourite is one boolean, so there is nothing a per-asset PATCH
// would carry that this does not.
//
// Editor, like every library write (lib/authz.ts default) — and it is allowed
// on the Gallery too: it does not judge a final, it only says "show this one".
import type { NextRequest } from "next/server";
import { z } from "zod";
import { MAX_FAVOURITE_IDS, setFavourites } from "@/lib/favourites";
import { authViaFromHeaders, identityFromHeaders } from "@/lib/auth";
import { json, badRequest, serverError } from "@/lib/api";

const Body = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(MAX_FAVOURITE_IDS),
  favourite: z.boolean(),
});

export async function POST(req: NextRequest) {
  try {
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return badRequest("Invalid parameters", parsed.error.issues);
    const { ids, favourite } = parsed.data;
    const { changed } = await setFavourites({
      ids,
      on: favourite,
      userId: identityFromHeaders(req.headers)?.id ?? null,
      via: authViaFromHeaders(req.headers),
    });
    return json({ favourite, requested: ids.length, changed });
  } catch (err) {
    return serverError(err);
  }
}
