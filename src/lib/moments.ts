// Moments — one folder folded into what a person remembers having shot, for
// the favourites pass (docs/FAVOURITES.md §5). Pure: no database, no I/O, so
// the rules below are tested as they are (moments.test.ts).
//
// A moment is a run of frames the photographer would pick ONE of:
//   1. a burst pile (lib/bursts.ts) is always one moment;
//   2. a frame joins the moment before it when it is the same kind of media,
//      at most LOOKALIKE_GAP_S after the moment's last frame, and its
//      perceptual hash is within LOOKALIKE_BITS of that last frame's — the
//      same look-alike rule Atelier's recap pool uses (8 bits, 10 minutes,
//      its `shared/sources/winnow/picture-rules.ts`), so a moment here is a
//      duplicate there;
//   3. a moment never spans more than MAX_SPAN_S, so a slow pan of near-
//      identical frames cannot chain a whole afternoon into one tile;
//   4. a frame with no hash (not analysed yet) only joins through its pile.
//
// The pass shows one tile per moment. Its cover is the member the person
// already chose (a favourite, then a pick, then the most stars), else the
// sharpest, else the first — never a fixed position, so a ♥ set on frame 3 of
// a moment is what the tile shows.

export const LOOKALIKE_BITS = 8;
export const LOOKALIKE_GAP_S = 10 * 60;
export const MAX_SPAN_S = 30 * 60;

export type MomentFrame = {
  id: number;
  captured_at: string | null;
  media_type: "photo" | "video";
  /** 64-bit dHash as node-postgres hands a BIGINT over: a decimal string. */
  phash: string | null;
  burst_id: number | null;
  sharpness: number | null;
  face_count: number | null;
  verdict: "pick" | "reject" | "skip" | "unrated";
  star: number;
  favourite: boolean;
};

export type Moment = {
  /** The member the tile shows (see the cover rule above). */
  cover_id: number;
  /** Every member, in capture order. */
  ids: number[];
  /** Members already marked ♥. */
  favourite_ids: number[];
  captured_at: string | null;
  media_type: "photo" | "video";
  /** Set by `suggest`: why this moment is worth a look. Never a write. */
  suggested?: string;
};

function bits(x: bigint): number {
  let n = 0;
  let v = x < 0n ? x + (1n << 64n) : x;
  while (v) {
    v &= v - 1n;
    n++;
  }
  return n;
}

export function hamming(a: string, b: string): number {
  return bits(BigInt.asUintN(64, BigInt(a)) ^ BigInt.asUintN(64, BigInt(b)));
}

function seconds(t: string | null): number | null {
  if (!t) return null;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

function alike(prev: MomentFrame, next: MomentFrame): boolean {
  if (prev.media_type !== next.media_type) return false;
  if (!prev.phash || !next.phash) return false;
  const a = seconds(prev.captured_at);
  const b = seconds(next.captured_at);
  if (a == null || b == null || b - a > LOOKALIKE_GAP_S) return false;
  return hamming(prev.phash, next.phash) <= LOOKALIKE_BITS;
}

function rank(f: MomentFrame): number[] {
  // Higher is better, compared left to right.
  return [
    f.favourite ? 1 : 0,
    f.verdict === "pick" ? 1 : 0,
    f.star,
    f.verdict === "reject" ? -1 : 0,
    f.sharpness ?? -1,
  ];
}

function better(a: MomentFrame, b: MomentFrame): boolean {
  const ra = rank(a);
  const rb = rank(b);
  for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] > rb[i];
  return false; // a tie keeps the earlier frame
}

// Frames in any order; moments come back in capture order.
export function groupMoments(frames: MomentFrame[]): Moment[] {
  const sorted = [...frames].sort((x, y) => {
    const a = seconds(x.captured_at) ?? Number.POSITIVE_INFINITY;
    const b = seconds(y.captured_at) ?? Number.POSITIVE_INFINITY;
    return a !== b ? a - b : x.id - y.id;
  });
  const runs: MomentFrame[][] = [];
  const pileRun = new Map<number, MomentFrame[]>();
  for (const f of sorted) {
    if (f.burst_id != null && pileRun.has(f.burst_id)) {
      pileRun.get(f.burst_id)!.push(f);
      continue;
    }
    const cur = runs[runs.length - 1];
    const last = cur?.[cur.length - 1];
    const start = cur ? seconds(cur[0].captured_at) : null;
    const at = seconds(f.captured_at);
    const withinSpan = start != null && at != null && at - start <= MAX_SPAN_S;
    if (cur && last && withinSpan && f.burst_id == null && alike(last, f)) {
      cur.push(f);
      continue;
    }
    const run = [f];
    runs.push(run);
    if (f.burst_id != null) pileRun.set(f.burst_id, run);
  }
  return runs.map((run) => {
    let cover = run[0];
    for (const f of run) if (better(f, cover)) cover = f;
    return {
      cover_id: cover.id,
      ids: run.map((f) => f.id),
      favourite_ids: run.filter((f) => f.favourite).map((f) => f.id),
      captured_at: run[0].captured_at,
      media_type: run[0].media_type,
    };
  });
}

// Suggestions for the pass: a few moments worth a first look, each with the
// one reason a person can check by eye. A hint drawn on the tile, never a
// write — the person's tap is the only thing that sets a ♥ (the project's
// rule: a heuristic is only ever a suggestion). Moments that already hold a
// favourite are not suggested; rejects never are.
export function suggest(moments: Moment[], frames: MomentFrame[], target = 15): Moment[] {
  const byId = new Map(frames.map((f) => [f.id, f]));
  const sharp = frames
    .map((f) => f.sharpness)
    .filter((s): s is number => s != null)
    .sort((a, b) => a - b);
  const sharpCut = sharp.length >= 4 ? sharp[Math.floor(sharp.length * 0.75)] : Number.POSITIVE_INFINITY;
  const scored = moments.map((m, i) => {
    const f = byId.get(m.cover_id)!;
    // Each signal adds to the score; the first one that applies is the reason
    // printed on the tile.
    const signals: Array<[boolean, number, string]> = [
      [f.verdict === "pick", 4, "Pick"],
      [f.star > 0, f.star, `★${f.star}`],
      [(f.face_count ?? 0) > 0, 2, "Faces"],
      [f.sharpness != null && f.sharpness >= sharpCut, 1, "Sharp"],
      [m.ids.length >= 3, 1, `${m.ids.length} frames`],
    ];
    let score = 0;
    let why = "";
    for (const [on, weight, label] of signals) {
      if (!on) continue;
      score += weight;
      if (!why) why = label;
    }
    const eligible = m.favourite_ids.length === 0 && f.verdict !== "reject" && score > 0;
    return { i, score, why, eligible };
  });
  const room = Math.max(0, target - moments.filter((m) => m.favourite_ids.length > 0).length);
  const chosen = new Map(
    scored
      .filter((s) => s.eligible)
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .slice(0, room)
      .map((s) => [s.i, s.why]),
  );
  return moments.map((m, i) => (chosen.has(i) ? { ...m, suggested: chosen.get(i) } : m));
}
