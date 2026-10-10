// The folder-pair view of the deduplication backlog (Settings › Pipeline ›
// Failures › Deduplication, "By folder pair").
//
// Duplicates do not arrive one file at a time: a card imported twice, a backup
// folder, a "(copy)" made by hand — a whole folder's worth at once. The group
// view asks the same question four hundred times; this view asks it once per
// pair of folders: which side do you keep?
//
// A PAIR is the two folders a two-copy group lives in. Only those groups form
// pairs: with three copies there is no "side", and two copies in one folder (a
// renamed file) have no folder to choose — both stay in the group view, and the
// listing says how many there are.
//
// Same derivation as everything else on the page (selectGroups), and the same
// contract for the action: the caller names the two FOLDERS, never a list of
// groups, and the server re-derives which groups the pair holds and which copy
// survives. Every group still goes through keepOneCopy.
import path from "node:path";
import { viewOnlyChecker } from "./duplicates";
import {
  keepEach,
  selectGroups,
  type DuplicateListQuery,
  type KeepEachResult,
} from "./duplicateList";
import type {
  DuplicateGroup,
  DuplicatePair,
  DuplicatePairList,
  DuplicatePairSide,
  DuplicateZone,
} from "./duplicateTypes";

type Member = {
  path: string;
  dir: string;
  zone: DuplicateZone;
  view_only: boolean;
  lib: "live" | "trashed" | null;
};

// Every copy of a group that still has bytes: the library entry (unless
// purged), then the recorded on-disk copies — the members keepOneCopy sees.
function membersOf(g: DuplicateGroup): Member[] {
  const lib =
    g.existing && !g.existing.purged && g.existing.abs_path ? g.existing : null;
  const out: Member[] = [];
  if (lib)
    out.push({
      path: lib.abs_path!,
      dir: path.posix.dirname(lib.abs_path!),
      zone: lib.zone,
      view_only: lib.view_only,
      lib: lib.deleted ? "trashed" : "live",
    });
  for (const c of g.copies)
    if (c.abs_path !== lib?.abs_path)
      out.push({
        path: c.abs_path,
        dir: path.posix.dirname(c.abs_path),
        zone: c.zone,
        view_only: c.view_only,
        lib: null,
      });
  return out;
}

// The group's two members, in two different folders — or null when the group
// is no pair (stale, three or more copies, or both copies in one folder).
export function pairOf(g: DuplicateGroup): [Member, Member] | null {
  if (g.stale) return null;
  const m = membersOf(g);
  if (m.length !== 2 || m[0].dir === m[1].dir) return null;
  return m[0].dir < m[1].dir ? [m[0], m[1]] : [m[1], m[0]];
}

const keyOf = (a: string, b: string) => `${a}\n${b}`;

function side(m: Member): DuplicatePairSide {
  return {
    dir: m.dir,
    zone: m.zone,
    view_only: m.view_only,
    library: 0,
    trashed: 0,
  };
}

export async function listDuplicatePairs(
  query: DuplicateListQuery = {},
): Promise<DuplicatePairList> {
  const limit = Math.min(Math.max(query.limit ?? 40, 1), 200);
  const offset = Math.max(query.offset ?? 0, 0);
  // The pair view is its own split of the backlog: the plan's `rule` filter
  // does not apply to it.
  const { matched } = await selectGroups({ ...query, rule: undefined });

  // Aggregate in the folders' canonical order (a < b), and remember for each
  // group which canonical side autoKeep would keep.
  type Acc = DuplicatePair & { votes: Set<"a" | "b" | null> };
  const byKey = new Map<string, Acc>();
  let unpaired = 0;
  for (const g of matched) {
    if (g.stale) continue;
    const pair = pairOf(g);
    if (!pair) {
      unpaired++;
      continue;
    }
    const [a, b] = pair;
    const key = keyOf(a.dir, b.dir);
    let acc = byKey.get(key);
    if (!acc) {
      acc = {
        key,
        left: side(a),
        right: side(b),
        groups: 0,
        bytes: 0,
        suggest: null,
        sample: [],
        votes: new Set(),
      };
      byKey.set(key, acc);
    }
    acc.groups++;
    acc.bytes += g.file_size ?? 0;
    if (a.lib === "live") acc.left.library++;
    if (a.lib === "trashed") acc.left.trashed++;
    if (b.lib === "live") acc.right.library++;
    if (b.lib === "trashed") acc.right.trashed++;
    acc.votes.add(
      g.auto_keep === a.path ? "a" : g.auto_keep === b.path ? "b" : null,
    );
    if (acc.sample.length < 3) acc.sample.push(path.posix.basename(a.path));
  }

  const pairs: DuplicatePair[] = [...byKey.values()].map(({ votes, ...p }) => {
    // The rule's pick, when every group of the pair agrees on a side.
    const only = votes.size === 1 ? [...votes][0] : null;
    let pair: DuplicatePair = {
      ...p,
      suggest: only === "a" ? "left" : only === "b" ? "right" : null,
    };
    // Display order: the side holding the library entries on the left — it is
    // the one most pairs keep — else the cullable side, else the folder name.
    const swap =
      pair.right.library > pair.left.library ||
      (pair.right.library === pair.left.library &&
        pair.left.view_only &&
        !pair.right.view_only);
    if (swap)
      pair = {
        ...pair,
        key: keyOf(pair.right.dir, pair.left.dir),
        left: pair.right,
        right: pair.left,
        suggest:
          pair.suggest === "left" ? "right" : pair.suggest === "right" ? "left" : null,
      };
    return pair;
  });
  pairs.sort((x, y) => y.bytes - x.bytes || y.groups - x.groups);

  return {
    pairs: pairs.slice(offset, offset + limit),
    matched: pairs.length,
    unpaired,
    limit,
    offset,
  };
}

export class PairRefused extends Error {}

// Keep every copy on `keepDir` side of the pair (keepDir, dropDir), within the
// current filter, one bounded batch at a time — the folder-pair counterpart of
// resolveDuplicatesAuto, with the same `exclude`/`retry` contract.
//
// Refused up front when the side to drop is a view-only volume: its copies are
// never deleted, so "keep the other side" has no meaning there (keepOneCopy
// would refuse each group one by one anyway; this says so once).
export async function resolveDuplicatePair(
  query: DuplicateListQuery & {
    keepDir: string;
    dropDir: string;
    max?: number;
    exclude?: string[];
  },
): Promise<KeepEachResult> {
  const { keepDir, dropDir } = query;
  if (keepDir === dropDir) throw new PairRefused("The two folders are the same.");
  const isViewOnly = await viewOnlyChecker();
  if (isViewOnly(path.posix.join(dropDir, "x")))
    throw new PairRefused(
      "The folder to drop is on a view-only volume (Final/Export): its copies are never deleted.",
    );

  const max = Math.min(Math.max(query.max ?? 100, 1), 500);
  const exclude = new Set(query.exclude ?? []);
  const inPair = async () => {
    const { matched } = await selectGroups({ ...query, rule: undefined });
    const out: { hash: string; keepPath: string }[] = [];
    for (const g of matched) {
      const pair = pairOf(g);
      if (!pair) continue;
      const keep = pair.find((m) => m.dir === keepDir);
      const drop = pair.find((m) => m.dir === dropDir);
      if (keep && drop) out.push({ hash: g.hash, keepPath: keep.path });
    }
    return out;
  };

  const targets = (await inPair()).filter((t) => !exclude.has(t.hash)).slice(0, max);
  const result = await keepEach(targets);
  const left = new Set([...exclude, ...result.retry]);
  result.remaining = (await inPair()).filter((t) => !left.has(t.hash)).length;
  return result;
}
