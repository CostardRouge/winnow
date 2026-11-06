// Favourites — the binary "show this one" mark (migration 0058,
// docs/FAVOURITES.md). Beside the cull and never part of it: setting or
// clearing one touches no verdict, no star, no `processing_state`, so a
// session's progress is the same before and after. It is also the one mark
// the Gallery allows — a final is accepted as it is, but a recap still needs
// to know which finals to reach for.
//
// Shared like a rating (one row per asset, whoever set it), and a RAW+JPEG
// pair or a Live Photo is one media: every write cascades to the live
// members of the asset's group through `groupExpandCTE`, as a rating does.
// A burst pile is NOT expanded: the frame is the unit, as it is for a pick.
import { groupExpandCTE } from "./pairing";
import { q } from "./db";
import type { AuthVia } from "./auth";

// The cap of one call. A bulk gesture is a grid selection or a pass over one
// folder (the largest on the instance holds 3 886 media, 2026-11-06); a
// request asking for more is refused rather than cut, so nothing is half done
// without saying so.
export const MAX_FAVOURITE_IDS = 5000;

export interface FavouriteWrite {
  /** Asset ids as the client sent them (one side of a pair is enough). */
  ids: number[];
  /** true sets the mark, false clears it. */
  on: boolean;
  /** The account acting, stamped on the row (NULL when unknown). */
  userId: number | null;
  /** The credential it came through (a browser, an app, an agent). */
  via: AuthVia | null;
}

// Sets or clears the mark and answers how many FILES changed state — a pair
// counts twice, which is the honest number for the rows written; the UI
// announces the media it asked for, after this answer arrives.
export async function setFavourites(w: FavouriteWrite): Promise<{ changed: number }> {
  if (w.ids.length === 0) return { changed: 0 };
  if (w.on) {
    // Only live files: a trashed companion is not resurrected into a recap by
    // a favourite set on its surviving primary. An existing row keeps its
    // first date; the author is the last one who set it, as for a rating.
    const { rowCount } = await q(
      `WITH ${groupExpandCTE("$1")}
       INSERT INTO favourites (asset_id, favourited_by, favourited_via)
       SELECT t.id, $2, $3
         FROM target_ids t JOIN assets a ON a.id = t.id
        WHERE a.deleted_at IS NULL
       ON CONFLICT (asset_id) DO UPDATE SET
         favourited_by  = COALESCE(EXCLUDED.favourited_by, favourites.favourited_by),
         favourited_via = COALESCE(EXCLUDED.favourited_via, favourites.favourited_via)
       WHERE favourites.favourited_by IS DISTINCT FROM EXCLUDED.favourited_by
          OR favourites.favourited_via IS DISTINCT FROM EXCLUDED.favourited_via`,
      [w.ids, w.userId, w.via],
    );
    return { changed: rowCount ?? 0 };
  }
  // Clearing takes the whole group, trashed members included, so a pair can
  // never be left half favourited.
  const { rowCount } = await q(
    `WITH ${groupExpandCTE("$1")}
     DELETE FROM favourites WHERE asset_id IN (SELECT id FROM target_ids)`,
    [w.ids],
  );
  return { changed: rowCount ?? 0 };
}
