// Shapes shared by GET /api/failures/duplicates and the triage page. Kept apart
// from lib/duplicateList.ts — which pulls in the Postgres pool and the
// server-only config — so the client bundle can import the types without
// dragging the DB layer along (same split as gearTypes.ts / gear.ts).

// Which side of the library a single COPY sits in, decided from its path against
// the registered roots (lib/duplicates → zoneChecker). `roles.ts` answers the
// same question for an indexed asset via its session; a duplicate hit was never
// indexed, so the path is all there is.
//
// 'export' is kept apart from 'gallery' on purpose: an Export volume holds RAW
// copies that deliberately mirror the originals, so a hit there is expected
// noise rather than a finished master. 'other' is a browsable folder registered
// as no root at all.
export type DuplicateZone = "incoming" | "gallery" | "export" | "other";

// Which side of the library a whole GROUP lives on — the segmented picker at the
// top of the page. Not a zone: a group holds several copies, and the case that
// matters most ("mixed") is precisely the one whose copies disagree.
//   incoming  — every copy is still in the cullable tree
//   gallery   — every copy is a finalized master
//   mixed     — the same bytes exist on BOTH sides (or in an Export volume too)
//   elsewhere — Export volumes / folders registered as no root at all
export type DuplicateScope = "incoming" | "gallery" | "mixed" | "elsewhere";

export const DUPLICATE_SCOPES: DuplicateScope[] = [
  "incoming",
  "gallery",
  "mixed",
  "elsewhere",
];

export type DuplicateSort = "size" | "recent" | "path";

// The two branches of the bulk rule (lib/duplicateList → autoKeep), named so
// the page can say WHY a copy is the suggested survivor instead of only which:
//   protected — the one copy on a Final/Export volume, which is never deleted;
//   library   — the live library entry, with no protected copy in the group.
export type DuplicateAutoRule = "protected" | "library";

// Where a group sits in the cleanup PLAN: one of the rule's branches, or
// "manual" when no rule can pick the survivor and a human has to. A stale group
// (nothing shadows it any more) is in none of them — "Clear resolved" drops it.
export type DuplicatePlanKey = DuplicateAutoRule | "manual";

export const DUPLICATE_PLAN_KEYS: DuplicatePlanKey[] = [
  "protected",
  "library",
  "manual",
];

/** The indexed asset holding this content: live, in the trash, or purged. */
export type DuplicateExisting = {
  id: number;
  filename: string | null;
  abs_path: string | null;
  media_type: string | null;
  has_thumb: boolean;
  deleted: boolean;
  purged: boolean;
  /** On a Final/Export volume — never deleted by deduplication. */
  view_only: boolean;
  zone: DuplicateZone;
  is_raw: boolean;
};

/** One recorded on-disk copy of the group's content. */
export type DuplicateCopy = {
  abs_path: string;
  source: string;
  hits: number;
  file_size: number | null;
  updated_at: string;
  view_only: boolean;
  zone: DuplicateZone;
  is_raw: boolean;
};

export type DuplicateGroup = {
  hash: string;
  existing: DuplicateExisting | null;
  copies: DuplicateCopy[];
  scope: DuplicateScope;
  zones: DuplicateZone[];
  members: number;
  file_size: number | null;
  /** Copies that would go if the group were collapsed (protected ones never do). */
  extras: number;
  /** Bytes those extras hold — what collapsing the group frees. */
  reclaimable: number;
  /** A RAW master sitting in the Gallery — what the workflow says should never happen. */
  raw_in_gallery: boolean;
  /** Nothing shadows this content any more: the next sweep clears the row. */
  stale: boolean;
  /** The survivor the bulk rule would pick, or null when the group needs a human. */
  auto_keep: string | null;
  /** Which branch of that rule picked it — what the page prints as the reason. */
  auto_rule: DuplicateAutoRule | null;
  updated_at: string;
};

// A false collision is never grouped (distinct content sharing a partial hash),
// so it carries no survivor and no reclaimable bytes — just enough to inspect it.
export type DuplicateFalseItem = {
  abs_path: string;
  content_hash: string;
  source: string;
  file_size: number | null;
  zone: DuplicateZone;
  existing: {
    id: number;
    filename: string | null;
    abs_path: string | null;
  } | null;
};

export type DuplicateFacet = {
  groups: number;
  /** Extra copies that would go if every group in the facet were collapsed. */
  extras: number;
  reclaimable: number;
};

export type DuplicateListResult = {
  /** Every recorded row — matches the Failures badge exactly. */
  total: number;
  falseCollisions: number;
  /** Groups matching the current filter (the page below is a slice of these). */
  matched: number;
  groups: DuplicateGroup[];
  falseItems: DuplicateFalseItem[];
  facets: Record<DuplicateScope | "all", DuplicateFacet>;
  /** The plan: the current scope's groups split by who picks the survivor —
   *  counted before the `rule` filter, so every card keeps its number while
   *  the list shows one of them. */
  plan: Record<DuplicatePlanKey, DuplicateFacet>;
  /** Groups the bulk rule could resolve on its own, within the current filter. */
  autoResolvable: number;
  /** Bytes those groups alone would free — what the bulk confirmation promises. */
  autoReclaimable: number;
  /** Groups whose row is already meaningless (cf. sweepResolvedDuplicateHits). */
  stale: number;
  /** RAW masters found in the Gallery, over the WHOLE table — a standing report. */
  rawInGallery: { groups: number; bytes: number };
  limit: number;
  offset: number;
};

export type ResolveAutoResult = {
  /** Groups collapsed onto their survivor. */
  resolved: number;
  /** Files actually removed from disk. */
  deleted: number;
  /** Library entries re-pointed at the surviving copy. */
  relinked: number;
  /** Groups that errored or whose copies were all refused — left listed. */
  failed: number;
  /** Auto-resolvable groups still matching the filter afterwards. */
  remaining: number;
  /** Why copies or whole groups were left alone, grouped and counted — the
   *  report says what happened to every group it did not collapse. */
  skipped: { reason: string; count: number }[];
};

export type SweepResolvedResult = {
  checked: number;
  /** Rows dropped because their file is no longer on disk. */
  purged: number;
  /** Purged asset rows whose content_hash was released. */
  released: number;
  /** Rows dropped because nothing shadows their content any more. */
  stale: number;
};

// ---- Folder pairs ---------------------------------------------------------
//
// Duplicates arrive by whole folders (a card imported twice, a backup, a
// "(copy)" folder), so the pair view groups two-copy groups by the two folders
// they live in: one decision per pair keeps every copy on one side.

export type DuplicatePairSideKey = "left" | "right";

export type DuplicatePairSide = {
  /** The folder, with no trailing slash. */
  dir: string;
  zone: DuplicateZone;
  /** On a Final/Export volume: its copies are never deleted. */
  view_only: boolean;
  /** Groups whose LIVE library entry is the copy on this side. */
  library: number;
  /** Groups whose library entry on this side is in the trash. */
  trashed: number;
};

export type DuplicatePair = {
  /** Stable id of the pair: the two folders, left then right. */
  key: string;
  left: DuplicatePairSide;
  right: DuplicatePairSide;
  /** Two-copy groups with one copy on each side. */
  groups: number;
  /** Bytes on ONE side — what keeping the other frees. */
  bytes: number;
  /** The side autoKeep would keep in every group of the pair, if they agree. */
  suggest: DuplicatePairSideKey | null;
  /** A few file names, to recognise the pair at a glance. */
  sample: string[];
};

export type DuplicatePairList = {
  pairs: DuplicatePair[];
  /** Pairs matching the filter (the page above is a slice of these). */
  matched: number;
  /** Groups in the filter that are no pair: three or more copies, or two in
   *  the same folder — they stay in the group view. */
  unpaired: number;
  limit: number;
  offset: number;
};
