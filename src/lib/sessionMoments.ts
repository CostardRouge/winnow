// One folder read as moments for the favourites pass (docs/FAVOURITES.md §5):
// the database half of lib/moments.ts, which stays pure.
//
// Reads the folder's live media with pairs folded (the pass is one tile per
// media, never per file) and burst piles UNFOLDED (lib/moments.ts makes the
// pile one moment itself, and the sheet must list every frame of it).
import { manyWithoutJit, one } from "./db";
import { buildFilter } from "./filter";
import { groupMoments, suggest, type Moment, type MomentFrame } from "./moments";

// The whole folder is read in one statement: the largest on the instance holds
// 3 886 media (2026-11-06). Above this cap the pass refuses and says so rather
// than showing part of a folder as all of it (docs/SILENT-LIMITS-AUDIT.md).
export const MAX_PASS_MEDIA = 10_000;

export type PassFrame = MomentFrame & { ready: boolean };

export type SessionMoments = {
  session: { id: number; name: string; root_kind: string };
  frames: PassFrame[];
  moments: Moment[];
};

export class TooManyMedia extends Error {
  constructor(readonly count: number) {
    super(
      `This folder holds ${count.toLocaleString("en-GB")} media; the favourites pass reads up to ${MAX_PASS_MEDIA.toLocaleString("en-GB")}. Use the folder's grid and ♥ Favourite on a selection.`,
    );
  }
}

export async function loadSessionMoments(sessionId: number): Promise<SessionMoments | null> {
  const session = await one<{ id: number; name: string; root_kind: string }>(
    `SELECT s.id, s.name, rt.kind AS root_kind
       FROM sessions s JOIN roots rt ON rt.id = s.root_id
      WHERE s.id = $1`,
    [sessionId],
  );
  if (!session) return null;
  const { conditions, params } = buildFilter({ session_id: sessionId }, 1, {
    collapseGroups: true,
    collapseBursts: false,
  });
  const rows = await manyWithoutJit<{
    id: string | number;
    captured_at: Date | string | null;
    media_type: "photo" | "video";
    phash: string | null;
    burst_id: string | number | null;
    sharpness: number | null;
    face_count: number | null;
    verdict: MomentFrame["verdict"];
    star: number;
    favourite: boolean;
    ready: boolean;
  }>(
    `SELECT a.id, a.captured_at, a.media_type, a.phash::text AS phash, a.burst_id,
            a.sharpness, a.face_count,
            COALESCE(r.verdict, 'unrated') AS verdict, COALESCE(r.star, 0) AS star,
            EXISTS (SELECT 1 FROM favourites fv WHERE fv.asset_id = a.id) AS favourite,
            (a.derivative_status = 'ready') AS ready
       FROM assets a LEFT JOIN ratings r ON r.asset_id = a.id
      WHERE ${conditions.join(" AND ")}
      ORDER BY a.captured_at ASC NULLS LAST, a.id ASC
      LIMIT $${params.length + 1}`,
    [...params, MAX_PASS_MEDIA + 1],
  );
  if (rows.length > MAX_PASS_MEDIA) {
    const c = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM assets a LEFT JOIN ratings r ON r.asset_id = a.id
        WHERE ${conditions.join(" AND ")}`,
      params,
    );
    throw new TooManyMedia(c?.n ?? rows.length);
  }
  const frames: PassFrame[] = rows.map((r) => ({
    id: Number(r.id),
    captured_at:
      r.captured_at instanceof Date ? r.captured_at.toISOString() : (r.captured_at ?? null),
    media_type: r.media_type,
    phash: r.phash,
    burst_id: r.burst_id == null ? null : Number(r.burst_id),
    sharpness: r.sharpness == null ? null : Number(r.sharpness),
    face_count: r.face_count == null ? null : Number(r.face_count),
    verdict: r.verdict,
    star: Number(r.star) || 0,
    favourite: r.favourite,
    ready: r.ready,
  }));
  return { session, frames, moments: suggest(groupMoments(frames), frames) };
}
