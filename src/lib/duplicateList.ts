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

  g.auto_keep = autoKeepPath(g, lib);
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
function autoKeepPath(
  g: DuplicateGroup,
  lib: DuplicateExisting | null,
): string | null {
  if (g.members < 2) return null;
  const protectedPaths = [
    ...(lib?.view_only && lib.abs_path ? [lib.abs_path] : []),
    ...g.copies.filter((c) => c.view_only).map((c) => c.abs_path),
  ];
  if (protectedPaths.length > 1) return null;
  if (protectedPaths.length === 1) {
    // `lib` is already null when the entry is purged (no bytes to keep).
    if (lib && lib.abs_path && lib.abs_path !== protectedPaths[0]) return null;
    return protectedPaths[0];
  }
  if (lib && !lib.deleted && lib.abs_path) return lib.abs_path;
  return null;
}

function matches(g: DuplicateGroup, needle: string): boolean {
  if (!needle) return true;
  if (g.existing?.abs_path?.toLowerCase().includes(needle)) return true;
  return g.copies.some((c) => c.abs_path.toLowerCase().includes(needle));
}

function emptyFacet(): DuplicateFacet {
  return { groups: 0, extras: 0, reclaimable: 0 };
}

// Filter → facet → sort. One table pass, shared by the listing (which slices a
// page out of `matched`) and the bulk resolution (which walks it in order), so
// the two can never disagree about which groups a filter selects.
//
// The facets are counted over the path/RAW filter but NOT over the scope, so the
// tab badges keep showing where the rest of the matches are instead of
// collapsing to the tab you are already on.
async function selectGroups(query: DuplicateListQuery) {
  const { groups, falseItems, total, falseCount } = await buildGroups();
  const needle = (query.q ?? "").trim().toLowerCase();

  const rawInGallery = groups.reduce(
    (acc, g) =>
      g.raw_in_gallery
        ? { groups: acc.groups + 1, bytes: acc.bytes + (g.file_size ?? 0) }
        : acc,
    { groups: 0, bytes: 0 },
  );

  const preScope = groups.filter(
    (g) => matches(g, needle) && (!query.rawInGallery || g.raw_in_gallery),
  );

  const facets = {
    all: emptyFacet(),
    incoming: emptyFacet(),
    gallery: emptyFacet(),
    mixed: emptyFacet(),
    elsewhere: emptyFacet(),
  } as Record<DuplicateScope | "all", DuplicateFacet>;
  for (const g of preScope) {
    for (const key of ["all", g.scope] as const) {
      facets[key].groups++;
      facets[key].extras += g.extras;
      facets[key].reclaimable += g.reclaimable;
    }
  }

  const matched =
    query.scope && query.scope !== "all"
      ? preScope.filter((g) => g.scope === query.scope)
      : preScope;

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

  return {
    total: s.total,
    falseCollisions: s.falseCount,
    matched: s.matched.length,
    groups: s.matched.slice(offset, offset + limit),
    falseItems: s.falseItems,
    facets: s.facets,
    autoResolvable: auto.length,
    autoReclaimable: auto.reduce((n, g) => n + g.reclaimable, 0),
    stale: s.matched.filter((g) => g.stale).length,
    rawInGallery: s.rawInGallery,
    limit,
    offset,
  };
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
export async function resolveDuplicatesAuto(
  query: DuplicateListQuery & { max?: number },
): Promise<ResolveAutoResult> {
  const max = Math.min(Math.max(query.max ?? 100, 1), 500);
  const targets = (await selectGroups(query))
    .matched.filter((g) => g.auto_keep)
    .slice(0, max);

  const result: ResolveAutoResult = {
    resolved: 0,
    deleted: 0,
    relinked: 0,
    failed: 0,
    remaining: 0,
  };
  for (const g of targets) {
    try {
      const r = await keepOneCopy({
        contentHash: g.hash,
        keepPath: g.auto_keep!,
      });
      result.resolved++;
      result.deleted += r.deleted.length;
      if (r.relinked) result.relinked++;
    } catch (err) {
      // A group that can't be collapsed (a copy vanished under us, a permission
      // error) must not abort the batch: it keeps its rows and stays listed for
      // the user, exactly as if it had never been picked.
      if (!(err instanceof DuplicateError))
        console.warn("resolveDuplicatesAuto:", (err as Error).message);
      result.failed++;
    }
  }

  // What a next batch would still find. NOTE for the caller: a group that keeps
  // failing stays counted here, so a loop must stop on `resolved === 0`, not on
  // `remaining === 0`, or it spins forever on the same refusals.
  result.remaining = (await selectGroups(query)).matched.filter(
    (g) => g.auto_keep,
  ).length;
  return result;
}
