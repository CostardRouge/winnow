// Read model for the deduplication triage page (Settings › Pipeline › Failures
// › Deduplication). `duplicates.ts` holds the operations that TOUCH files; this
// holds the view that makes a five-thousand-row backlog navigable, plus the one
// bulk operation built on top of it.
//
// Why a dedicated module rather than more SQL in the route: the grouping key is
// `content_hash`, but everything the page filters and ranks on — which zone a
// copy sits in, whether it is a RAW, how many bytes collapsing the group frees,
// which copy the bulk rule would keep — is derived per PATH, not per row. Doing
// that in SQL would mean shipping the roots table into every predicate. The
// table is bounded by the number of duplicate FILES (a few thousand), so one
// pass in memory is both simpler and honest about the cost; the route sends only
// the requested page over the wire.
import { many } from "./db";
import { PHOTO_RAW_EXTS } from "./config";
import { keepOneCopy, viewOnlyChecker, zoneChecker, DuplicateError } from "./duplicates";
import type {
  DuplicateAutoRule,
  DuplicatePlanKey,
  DuplicateStrategy,
  StrategyPreview,
  DuplicateCopy,
  DuplicateExisting,
  DuplicateFacet,
  DuplicateFalseItem,
  DuplicateGroup,
  DuplicateListResult,
  DuplicateScope,
  DuplicateSort,
  DuplicateZone,
  ResolveAutoResult,
} from "./duplicateTypes";

export type * from "./duplicateTypes";

export type DuplicateListQuery = {
  scope?: DuplicateScope | "all";
  /** Case-insensitive substring over every path in the group. */
  q?: string;
  /** Keep only the groups with a RAW copy in the Gallery. */
  rawInGallery?: boolean;
  /** Keep only one card of the plan: a branch of the rule, or "manual". */
  rule?: DuplicatePlanKey;
  /** Annotate each listed group with what this strategy would keep. */
  strategy?: DuplicateStrategy;
  /** The text the "folder" strategy looks for in a copy's path. */
  folder?: string;
  sort?: DuplicateSort;
  limit?: number;
  offset?: number;
};

const FALSE_ITEM_LIMIT = 100;

function isRaw(p: string): boolean {
  const dot = p.lastIndexOf(".");
  return dot > 0 && PHOTO_RAW_EXTS.has(p.slice(dot).toLowerCase());
}

type HitRow = {
  abs_path: string;
  content_hash: string;
  existing_asset_id: number | null;
  source: string;
  verified: boolean | null;
  hits: number;
  file_size: string | number | null;
  updated_at: string;
  existing_filename: string | null;
  existing_abs_path: string | null;
  existing_media_type: string | null;
  existing_has_thumb: boolean | null;
  existing_deleted: boolean | null;
  existing_purged: boolean | null;
};

// LEFT JOIN the matched asset: the copies are byte-identical, so its thumbnail
// stands in for the whole group, and its state (live / trashed / purged) is what
// decides whether the group can be collapsed at all. All DB-local — no NAS I/O,
// which is what lets the page reload freely.
const HITS_SQL = `
  SELECT d.abs_path, d.content_hash, d.existing_asset_id, d.source,
         d.verified, d.hits, d.file_size, d.updated_at,
         a.filename                 AS existing_filename,
         a.abs_path                 AS existing_abs_path,
         a.media_type               AS existing_media_type,
         (a.thumb_key IS NOT NULL)  AS existing_has_thumb,
         (a.deleted_at IS NOT NULL) AS existing_deleted,
         (a.purged_at IS NOT NULL)  AS existing_purged
    FROM duplicate_hits d
    LEFT JOIN assets a ON a.id = d.existing_asset_id
   ORDER BY d.content_hash, d.abs_path`;

// Whole table, grouped and classified. Everything the page can filter or sort on
// is decided here once; the caller then slices. Kept internal so the filtering
// and the bulk resolution below can never drift apart on what a group IS.
async function buildGroups(): Promise<{
  groups: DuplicateGroup[];
  falseItems: DuplicateFalseItem[];
  total: number;
  falseCount: number;
}> {
  const [rows, isViewOnly, zoneOf] = await Promise.all([
    many<HitRow>(HITS_SQL),
    viewOnlyChecker(),
    zoneChecker(),
  ]);

  // Which hashes a LIVE (non-purged) asset still holds. A hash nobody holds any
  // more is what makes a lone recorded copy stale — cf. step 3 of
  // sweepResolvedDuplicateHits, which clears exactly these.
  const hashes = [...new Set(rows.map((r) => r.content_hash))];
  const shadowed = new Set(
    (
      await many<{ content_hash: string }>(
        `SELECT DISTINCT content_hash FROM assets
          WHERE purged_at IS NULL AND content_hash = ANY($1::text[])`,
        [hashes],
      ).catch(() => [] as { content_hash: string }[])
    ).map((r) => r.content_hash),
  );

  const byHash = new Map<string, DuplicateGroup>();
  const falseItems: DuplicateFalseItem[] = [];
  let falseCount = 0;

  for (const r of rows) {
    const size = r.file_size == null ? null : Number(r.file_size);
    // verified === false is a FALSE collision: genuinely distinct content that
    // merely shares a partial hash. It is indexed on its own and must never be
    // grouped with — nor collapsed onto — anything.
    if (r.verified === false) {
      falseCount++;
      if (falseItems.length < FALSE_ITEM_LIMIT)
        falseItems.push({
          abs_path: r.abs_path,
          content_hash: r.content_hash,
          source: r.source,
          file_size: size,
          zone: zoneOf(r.abs_path),
          existing: r.existing_asset_id
            ? {
                id: r.existing_asset_id,
                filename: r.existing_filename,
                abs_path: r.existing_abs_path,
              }
            : null,
        });
      continue;
    }

    let g = byHash.get(r.content_hash);
    if (!g) {
      g = {
        hash: r.content_hash,
        existing: null,
        copies: [],
        scope: "elsewhere",
        zones: [],
        members: 0,
        file_size: null,
        extras: 0,
        reclaimable: 0,
        raw_in_gallery: false,
        stale: false,
        auto_keep: null,
        auto_rule: null,
        updated_at: r.updated_at,
      };
      byHash.set(r.content_hash, g);
    }
    if (!g.existing && r.existing_asset_id) {
      const p = r.existing_abs_path;
      g.existing = {
        id: r.existing_asset_id,
        filename: r.existing_filename,
        abs_path: p,
        media_type: r.existing_media_type,
        has_thumb: !!r.existing_has_thumb,
        deleted: !!r.existing_deleted,
        purged: !!r.existing_purged,
        view_only: p ? isViewOnly(p) : false,
        zone: p ? zoneOf(p) : "other",
        is_raw: p ? isRaw(p) : false,
      };
    }
    g.copies.push({
      abs_path: r.abs_path,
      source: r.source,
      hits: r.hits,
      file_size: size,
      updated_at: r.updated_at,
      view_only: isViewOnly(r.abs_path),
      zone: zoneOf(r.abs_path),
      is_raw: isRaw(r.abs_path),
    });
    if (r.updated_at > g.updated_at) g.updated_at = r.updated_at;
    if (size != null && g.file_size == null) g.file_size = size;
  }

  for (const g of byHash.values()) finalizeGroup(g, shadowed.has(g.hash));

  return {
    groups: [...byHash.values()],
    falseItems,
    total: rows.length,
    falseCount,
  };
}

// Everything derived from a group's members once they are all in: its zones and
// scope, what collapsing it would free, and whether the bulk rule can pick a
// survivor without asking. `shadowed` = a live asset still holds the hash.
function finalizeGroup(g: DuplicateGroup, shadowed: boolean): void {
  // A purged library copy has no bytes left, so it is not a member: it only
  // still holds the hash (which the sweep releases), exactly as keepOneCopy
  // treats it.
  const lib = g.existing && !g.existing.purged ? g.existing : null;
  const libPath = lib?.abs_path ?? null;

  const zones = new Set<DuplicateZone>(g.copies.map((c) => c.zone));
  if (lib) zones.add(lib.zone);
  g.zones = [...zones];
  g.members = g.copies.length + (libPath ? 1 : 0);
  g.scope =
    zones.size > 1
      ? "mixed"
      : zones.has("incoming")
        ? "incoming"
        : zones.has("gallery")
          ? "gallery"
          : "elsewhere";

  g.raw_in_gallery =
    g.copies.some((c) => c.is_raw && c.zone === "gallery") ||
    !!(lib && lib.is_raw && lib.zone === "gallery");

  // A copy on a view-only volume is never removed (VIEW_ONLY_REASON), so it
  // never counts toward what a collapse frees — and if there IS one, it is the
  // survivor, meaning every deletable copy goes.
  const protectedMembers =
    g.copies.filter((c) => c.view_only).length + (lib?.view_only ? 1 : 0);
  const deletable = g.members - protectedMembers;
  g.extras = protectedMembers > 0 ? deletable : Math.max(0, deletable - 1);
  g.reclaimable = (g.file_size ?? 0) * g.extras;

  // Nothing holds these bytes any more and a single copy is left: not a
  // duplicate of anything, just a row nobody ever cleared.
  g.stale = !shadowed && g.members <= 1;

  const auto = autoKeep(g, lib);
  g.auto_keep = auto?.path ?? null;
  g.auto_rule = auto?.rule ?? null;
}

// The survivor the bulk rule picks — deliberately narrow, because a wrong pick
// deletes photographs. Two cases qualify, and only two:
//
//   1. EXACTLY ONE protected copy (Final/Export) and the library entry is that
//      copy, or there is none. It survives and the extras go. This is not a
//      preference but the app's own rule: those volumes are view-only, so the
//      other copies are the only ones deduplication could ever remove anyway.
//      This is also the shape of the backlog — a finalized master plus the
//      leftover copy of it still sitting in incoming.
//   2. NO protected copy and a LIVE library entry → it survives, and the
//      collapse degenerates into deleting the on-disk extras: the safe, boring
//      case that needs no opinion about where the file should live.
//
// Everything else stays manual, on purpose:
//   - two protected copies: neither may be deleted, so there is nothing to do;
//   - a protected copy that is NOT the library entry, while the entry still has
//     a file: collapsing onto it would relink a live asset onto a view-only
//     volume — moving the library's idea of where that photo lives, across
//     roots, without being asked. That includes the legitimate case of an
//     Export volume deliberately mirroring an incoming original, where the right
//     answer is to delete nothing at all;
//   - a library entry in the trash, or a group of on-disk copies with no indexed
//     one: which folder should hold the file is a judgement, not a chore.
//
// Returns the branch alongside the path: the page prints it as the reason the
// copy is suggested, which is what turns the bulk button from a leap of faith
// into something a human can check one group at a time.
export function autoKeep(
  g: Pick<DuplicateGroup, "members" | "copies">,
  lib: DuplicateExisting | null,
): { path: string; rule: DuplicateAutoRule } | null {
  if (g.members < 2) return null;
  const protectedPaths = [
    ...(lib?.view_only && lib.abs_path ? [lib.abs_path] : []),
    ...g.copies.filter((c) => c.view_only).map((c) => c.abs_path),
  ];
  if (protectedPaths.length > 1) return null;
  if (protectedPaths.length === 1) {
    // `lib` is already null when the entry is purged (no bytes to keep).
    if (lib && lib.abs_path && lib.abs_path !== protectedPaths[0]) return null;
    return { path: protectedPaths[0], rule: "protected" };
  }
  if (lib && !lib.deleted && lib.abs_path)
    return { path: lib.abs_path, rule: "library" };
  return null;
}

// The survivor a user-chosen STRATEGY keeps in a group, or why it leaves the
// group alone. Unlike autoKeep this is applied only on request, to a view the
// user narrowed — but it is just as unwilling to guess: a tie, no match or two
// matches skip the group. Two refusals hold for every strategy, the first
// because keepOneCopy would refuse anyway, the second by choice:
//   - a view-only library entry is never the loser;
//   - a LIVE library entry is never moved onto a view-only volume in bulk —
//     the exact case autoKeep excludes; "Keep only this" still allows it, one
//     group at a time, with the relink spelled out.
export function strategyKeep(
  g: Pick<DuplicateGroup, "existing" | "copies" | "stale">,
  strategy: DuplicateStrategy,
  folder?: string,
): { path: string } | { skip: string } {
  const lib =
    g.existing && !g.existing.purged && g.existing.abs_path ? g.existing : null;
  const members = [
    ...(lib ? [{ path: lib.abs_path!, view_only: lib.view_only }] : []),
    ...g.copies
      .filter((c) => c.abs_path !== lib?.abs_path)
      .map((c) => ({ path: c.abs_path, view_only: c.view_only })),
  ];
  if (g.stale || members.length < 2) return { skip: "not a duplicate any more" };

  let pick: string;
  if (strategy === "library") {
    if (!lib || lib.deleted) return { skip: "no live library entry" };
    pick = lib.abs_path!;
  } else if (strategy === "shortest") {
    const byLength = [...members].sort((a, b) => a.path.length - b.path.length);
    if (byLength[0].path.length === byLength[1].path.length)
      return { skip: "two copies have paths of the same length" };
    pick = byLength[0].path;
  } else {
    const needle = (folder ?? "").trim().toLowerCase();
    if (!needle) return { skip: "no folder given" };
    const hits = members.filter((m) => m.path.toLowerCase().includes(needle));
    if (hits.length === 0) return { skip: "no copy matches the folder" };
    if (hits.length > 1) return { skip: "several copies match the folder" };
    pick = hits[0].path;
  }

  if (lib?.view_only && pick !== lib.abs_path)
    return { skip: "the library copy is on a view-only volume and is never deleted" };
  // Keeping a trashed entry would leave the trash's next purge holding the
  // only copy — the call autoKeep leaves to a human, and so does this.
  if (lib?.deleted && pick === lib.abs_path)
    return { skip: "the copy it would keep is in the trash" };
  const kept = members.find((m) => m.path === pick)!;
  if (lib && !lib.deleted && pick !== lib.abs_path && kept.view_only)
    return { skip: "it would move the library entry onto a view-only volume" };
  return { path: pick };
}

// What keeping `pick` does to a group: files deleted (view-only copies stay)
// and whether the live library entry moves.
function outcomeOf(g: DuplicateGroup, pick: string) {
  const lib =
    g.existing && !g.existing.purged && g.existing.abs_path ? g.existing : null;
  const paths = [
    ...(lib ? [{ path: lib.abs_path!, view_only: lib.view_only }] : []),
    ...g.copies
      .filter((c) => c.abs_path !== lib?.abs_path)
      .map((c) => ({ path: c.abs_path, view_only: c.view_only })),
  ];
  const files = paths.filter((m) => m.path !== pick && !m.view_only).length;
  return {
    files,
    bytes: files * (g.file_size ?? 0),
    relink: !!(lib && !lib.deleted && lib.abs_path !== pick),
  };
}

function matches(g: DuplicateGroup, needle: string): boolean {
  if (!needle) return true;
  if (g.existing?.abs_path?.toLowerCase().includes(needle)) return true;
  return g.copies.some((c) => c.abs_path.toLowerCase().includes(needle));
}

function emptyFacet(): DuplicateFacet {
  return { groups: 0, extras: 0, reclaimable: 0 };
}

function count(f: DuplicateFacet, g: DuplicateGroup): void {
  f.groups++;
  f.extras += g.extras;
  f.reclaimable += g.reclaimable;
}

// The plan card a group belongs to: the branch of the rule that picks its
// survivor, or "manual". A stale group belongs to none — it is not a duplicate
// of anything any more, and "Clear resolved" is its only action.
export function planKey(
  g: Pick<DuplicateGroup, "stale" | "auto_rule">,
): DuplicatePlanKey | null {
  if (g.stale) return null;
  return g.auto_rule ?? "manual";
}

// Filter → facet → sort. One table pass, shared by the listing (which slices a
// page out of `matched`) and the bulk resolution (which walks it in order), so
// the two can never disagree about which groups a filter selects.
//
// The facets are counted over the path/RAW/rule filter but NOT over the scope,
// so the tab badges keep showing where the rest of the matches are instead of
// collapsing to the tab you are already on. The plan is the mirror image: counted
// over the scope but NOT over the rule, so every card keeps its number while the
// list below shows one of them.
// Exported for lib/duplicatePairs, which reads the same filtered groups by
// folder pair — one derivation of what a group IS, whatever the view.
export async function selectGroups(query: DuplicateListQuery) {
  const { groups, falseItems, total, falseCount } = await buildGroups();
  const needle = (query.q ?? "").trim().toLowerCase();

  const rawInGallery = groups.reduce(
    (acc, g) =>
      g.raw_in_gallery
        ? { groups: acc.groups + 1, bytes: acc.bytes + (g.file_size ?? 0) }
        : acc,
    { groups: 0, bytes: 0 },
  );

  const base = groups.filter(
    (g) => matches(g, needle) && (!query.rawInGallery || g.raw_in_gallery),
  );
  const inRule = (g: DuplicateGroup) => !query.rule || planKey(g) === query.rule;
  const inScope = (g: DuplicateGroup) =>
    !query.scope || query.scope === "all" || g.scope === query.scope;
  const preScope = base.filter(inRule);

  const facets = {
    all: emptyFacet(),
    incoming: emptyFacet(),
    gallery: emptyFacet(),
    mixed: emptyFacet(),
    elsewhere: emptyFacet(),
  } as Record<DuplicateScope | "all", DuplicateFacet>;
  for (const g of preScope) {
    count(facets.all, g);
    count(facets[g.scope], g);
  }

  const plan = {
    protected: emptyFacet(),
    library: emptyFacet(),
    manual: emptyFacet(),
  } as Record<DuplicatePlanKey, DuplicateFacet>;
  for (const g of base) {
    const key = planKey(g);
    if (key && inScope(g)) count(plan[key], g);
  }

  const matched = preScope.filter(inScope);

  const sort = query.sort ?? "size";
  matched.sort((a, b) => {
    if (sort === "recent") return b.updated_at.localeCompare(a.updated_at);
    if (sort === "path")
      return (a.copies[0]?.abs_path ?? "").localeCompare(
        b.copies[0]?.abs_path ?? "",
      );
    // Biggest win first: the point of the page is reclaiming disk.
    return b.reclaimable - a.reclaimable || b.members - a.members;
  });

  return {
    matched,
    falseItems: needle
      ? falseItems.filter((f) => f.abs_path.toLowerCase().includes(needle))
      : falseItems,
    facets,
    plan,
    rawInGallery,
    total,
    falseCount,
  };
}

export async function listDuplicateGroups(
  query: DuplicateListQuery = {},
): Promise<DuplicateListResult> {
  const limit = Math.min(Math.max(query.limit ?? 40, 1), 200);
  const offset = Math.max(query.offset ?? 0, 0);
  const s = await selectGroups(query);
  const auto = s.matched.filter((g) => g.auto_keep);
  const page = s.matched.slice(offset, offset + limit);
  if (query.strategy)
    for (const g of page) {
      const r = strategyKeep(g, query.strategy, query.folder);
      g.strategy_keep = "path" in r ? r.path : null;
      g.strategy_skip = "skip" in r ? r.skip : null;
    }

  return {
    total: s.total,
    falseCollisions: s.falseCount,
    matched: s.matched.length,
    groups: page,
    falseItems: s.falseItems,
    facets: s.facets,
    plan: s.plan,
    autoResolvable: auto.length,
    autoReclaimable: auto.reduce((n, g) => n + g.reclaimable, 0),
    stale: s.matched.filter((g) => g.stale).length,
    rawInGallery: s.rawInGallery,
    limit,
    offset,
  };
}

export type KeepEachResult = ResolveAutoResult & { retry: string[] };

// Run keepOneCopy over a batch of (group, survivor) picks — the one loop every
// bulk path shares (the plan's cards, the folder pairs), so they count, report
// and leave groups behind the same way. `remaining` is the caller's to fill.
export async function keepEach(
  targets: { hash: string; keepPath: string }[],
): Promise<KeepEachResult> {
  const result: KeepEachResult = {
    resolved: 0,
    deleted: 0,
    relinked: 0,
    failed: 0,
    remaining: 0,
    skipped: [],
    retry: [],
  };
  const reasons = new Map<string, number>();
  const note = (reason: string) => reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  for (const t of targets) {
    try {
      const r = await keepOneCopy({ contentHash: t.hash, keepPath: t.keepPath });
      result.resolved++;
      result.deleted += r.deleted.length;
      if (r.relinked) result.relinked++;
      // A copy keepOneCopy refused keeps its row, so the group stays listed:
      // say why, and do not pick it again in this run.
      for (const sk of r.skipped) note(sk.reason);
      if (r.skipped.length) result.retry.push(t.hash);
    } catch (err) {
      // A group that can't be collapsed (a copy vanished under us, a permission
      // error) must not abort the batch: it keeps its rows and stays listed for
      // the user, exactly as if it had never been picked.
      if (!(err instanceof DuplicateError))
        console.warn("keepEach:", (err as Error).message);
      note((err as Error).message);
      result.failed++;
      result.retry.push(t.hash);
    }
  }
  result.skipped = [...reasons]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);
  return result;
}

// Collapse, in one pass, every group in the current filter that the rule above
// can decide on its own. This is the answer to a five-thousand-entry backlog:
// the vast majority of those groups are "a finalized master plus its leftover
// copy in incoming", which has exactly one legal outcome, and clicking through
// them one at a time is not triage — it is data entry.
//
// Deliberately server-driven (the caller passes the FILTER, not a list of
// groups): the survivor is picked by the same code that displayed the preview,
// so a stale client list can never delete a copy the rule would no longer pick.
// Bounded per call so the request stays inside a normal HTTP lifetime — the
// caller loops on `remaining`, which also re-reads the table between batches.
//
// Every group still goes through keepOneCopy: full path whitelisting, the
// view-only refusal, the relink-before-unlink ordering and the audit-row
// cleanup are unchanged. This adds a picker, not a shortcut.
//
// `rule` narrows the run to one card of the plan (a branch of the rule). Asking
// for "manual" selects nothing: no rule picks a survivor there, by definition.
//
// `exclude` lists the groups this run already tried and left behind (returned
// as `retry` by earlier batches). It can only REMOVE groups from the run — the
// server still derives every survivor itself — and it is what keeps a batch
// from re-picking the same refused groups at the head of the size order while
// the rest of the backlog waits behind them.
export async function resolveDuplicatesAuto(
  query: DuplicateListQuery & { max?: number; exclude?: string[] },
): Promise<KeepEachResult> {
  const max = Math.min(Math.max(query.max ?? 100, 1), 500);
  const exclude = new Set(query.exclude ?? []);
  const pickable = (g: DuplicateGroup) => !!g.auto_keep && !exclude.has(g.hash);
  const targets = (await selectGroups(query)).matched.filter(pickable).slice(0, max);

  const result = await keepEach(
    targets.map((g) => ({ hash: g.hash, keepPath: g.auto_keep! })),
  );

  // What a next batch would still find, this run's refusals excluded. The
  // caller still stops on lack of progress too: a group can turn refusable
  // between two batches.
  const left = new Set([...exclude, ...result.retry]);
  result.remaining = (await selectGroups(query)).matched.filter(
    (g) => g.auto_keep && !left.has(g.hash),
  ).length;
  return result;
}

// What a strategy would do over the current view, before anything runs: the
// preview the page prints beside its Apply button, computed by the same
// strategyKeep the run uses. No disk access — the run re-checks every copy.
export async function previewStrategy(
  query: DuplicateListQuery & { strategy: DuplicateStrategy },
): Promise<StrategyPreview> {
  const { matched } = await selectGroups(query);
  const preview: StrategyPreview = {
    groups: 0,
    files: 0,
    bytes: 0,
    relinks: 0,
    skipped: [],
  };
  const reasons = new Map<string, number>();
  for (const g of matched) {
    if (g.stale) continue;
    const r = strategyKeep(g, query.strategy, query.folder);
    if ("skip" in r) {
      reasons.set(r.skip, (reasons.get(r.skip) ?? 0) + 1);
      continue;
    }
    const o = outcomeOf(g, r.path);
    preview.groups++;
    preview.files += o.files;
    preview.bytes += o.bytes;
    if (o.relink) preview.relinks++;
  }
  preview.skipped = [...reasons]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);
  return preview;
}

// Apply a strategy to the current view, one bounded batch at a time — the
// strategy counterpart of resolveDuplicatesAuto, same `exclude`/`retry`
// contract, same keepEach underneath.
export async function resolveStrategy(
  query: DuplicateListQuery & {
    strategy: DuplicateStrategy;
    max?: number;
    exclude?: string[];
  },
): Promise<KeepEachResult> {
  const max = Math.min(Math.max(query.max ?? 100, 1), 500);
  const exclude = new Set(query.exclude ?? []);
  const picks = async () => {
    const { matched } = await selectGroups(query);
    const out: { hash: string; keepPath: string }[] = [];
    for (const g of matched) {
      if (g.stale) continue;
      const r = strategyKeep(g, query.strategy, query.folder);
      if ("path" in r) out.push({ hash: g.hash, keepPath: r.path });
    }
    return out;
  };
  const targets = (await picks()).filter((t) => !exclude.has(t.hash)).slice(0, max);
  const result = await keepEach(targets);
  const left = new Set([...exclude, ...result.retry]);
  result.remaining = (await picks()).filter((t) => !left.has(t.hash)).length;
  return result;
}
