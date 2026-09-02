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
