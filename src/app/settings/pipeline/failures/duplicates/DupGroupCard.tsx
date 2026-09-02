"use client";

// One group of byte-identical copies and everything the user can do to it.
// Split out of the page because the page is now mostly navigation (tabs,
// search, paging, bulk actions) and this is the part that has to stay legible:
// a flat list of every place the content lives, each row saying what it is,
// where it sits, and what may be done to it.
//
// The library copy comes first when there is one, then every recorded on-disk
// copy. Winnow makes no assumption about which is "the original": the user picks
// the survivor with "Keep only this". One copy is never a candidate for removal
// — a Final/Export one — so it is drawn locked, and it is then the only survivor
// the group can collapse onto.
import { useState } from "react";
import { Icons, LazyImage } from "../../../../ui";
import MediaViewer from "../../../../MediaViewer";
import { formatBytes } from "../model";
import type {
  DuplicateExisting,
  DuplicateFalseItem,
  DuplicateGroup,
  DuplicateZone,
} from "@/lib/duplicateTypes";

const ZONE_LABEL: Record<DuplicateZone, string> = {
  incoming: "Incoming",
  gallery: "Gallery",
  export: "Export",
  other: "Elsewhere",
};

// A zone chip: which half of the library this copy sits in. The Gallery/Export
// ones double as the "you can't delete this" mark — those volumes are view-only.
export function ZonePill({ zone }: { zone: DuplicateZone }) {
  return (
    <span className={`pill dup-zone dup-zone-${zone}`} title={`In the ${ZONE_LABEL[zone]}`}>
      {ZONE_LABEL[zone]}
    </span>
  );
}

export default function DupGroupCard({
  group,
  sel,
  onToggleSel,
  onKeep,
  onDeleteCopy,
  onDiscardLibrary,
  busy,
}: {
  group: DuplicateGroup;
  sel: Set<string>;
  onToggleSel: (p: string) => void;
  onKeep: (keepPath: string, keepLabel: string) => void;
  onDeleteCopy: (p: string) => void;
  onDiscardLibrary: (existing: DuplicateExisting) => void;
  busy: boolean;
}) {
  const { existing, copies, hash } = group;
  const thumb = existing?.has_thumb ? `/api/assets/${existing.id}/thumb` : null;
  // The library copy is a finalized master on a view-only volume: it can never
  // be the one removed, so it's the only survivor this group can collapse onto.
  // "Keep only this" is left to it alone rather than offered and then refused.
  const lockedLibrary = !!existing?.view_only;
  const lockedHint =
    "The library copy is on a view-only volume (Final/Export) and is never deleted — keep that copy instead";
  // The identical copies share their bytes, so the library copy's preview stands
  // in for the whole group — open it full-size to eyeball before deciding.
  const [preview, setPreview] = useState(false);

  return (
    <div className="dup-group">
      <div className="dup-group-head">
        {thumb && existing ? (
          <button
            type="button"
            className="pl-thumb"
            onClick={() => setPreview(true)}
            title="Preview"
            aria-label="Preview the kept copy"
          >
            <LazyImage src={thumb} alt="" />
          </button>
        ) : (
          <div className="pl-thumb" aria-hidden>
            <span className="pl-thumb-empty">{Icons.photos}</span>
          </div>
        )}
        <div className="dup-main">
          <div className="dup-path">
            {group.members} identical {group.members === 1 ? "copy" : "copies"}
            {group.zones.map((z) => (
              <ZonePill key={z} zone={z} />
            ))}
            {/* The workflow's one hard rule: a RAW has no business in the
                finished Gallery — it should have been exported instead. Those
                volumes are view-only, so this is a report, not an action. */}
            {group.raw_in_gallery && (
              <span
                className="pill dup-flag-raw"
                title="A RAW master is sitting in the Gallery — export it and keep the RAW in Incoming instead"
              >
                RAW in Gallery
              </span>
            )}
            {group.stale && (
              <span
                className="pill dup-flag-stale"
                title="Nothing holds this content any more — “Clear resolved” drops this entry"
              >
                already resolved
              </span>
            )}
          </div>
          <div className="dup-sub">
            {group.file_size != null ? `${formatBytes(group.file_size)} each · ` : ""}
            {group.extras > 0
              ? `${formatBytes(group.reclaimable)} to reclaim · `
              : "nothing to reclaim · "}
            {hash.slice(0, 12)}…
          </div>
        </div>
      </div>

      <div className="dup-members">
        {existing && (
          <MemberRow
            // A trashed entry is still a copy of these bytes — it can be kept,
            // or dropped on its own (its file is removed and the row is stamped
            // purged; it stays in the trash). A purged one has no bytes left and
            // a view-only one is never deleted, trash or not: both are shown
            // without a delete.
            label={
              existing.view_only
                ? "In library (view-only)"
                : existing.purged
                  ? "In library (purged)"
                  : existing.deleted
                    ? "In library (in trash)"
                    : "In library"
            }
            zone={existing.abs_path ? existing.zone : undefined}
            primary={`#${existing.id} · ${existing.filename ?? "—"}`}
            sub={
              existing.view_only
                ? "on a Final/Export volume — never deleted by deduplication"
                : existing.purged
                  ? "already reclaimed — no file left on disk"
                  : existing.deleted
                    ? "soft-deleted, but its file is still on disk"
                    : undefined
            }
            path={existing.abs_path ?? "(path unknown)"}
            downloadHref={`/api/assets/${existing.id}/download`}
            canKeep={!!existing.abs_path && !existing.purged}
            onKeep={() => {
              if (existing.abs_path)
                onKeep(
                  existing.abs_path,
                  `#${existing.id} · ${existing.filename ?? existing.abs_path}`,
                );
            }}
            onDelete={
              existing.deleted &&
              !existing.purged &&
              !existing.view_only &&
              existing.abs_path
                ? () => onDiscardLibrary(existing)
                : undefined
            }
            deleteTitle="Delete this trashed copy's file"
            busy={busy}
          />
        )}
        {copies.map((c) => (
          <MemberRow
            key={c.abs_path}
            label={c.view_only ? "On disk (view-only)" : "On disk"}
            zone={c.zone}
            sub={
              c.view_only
                ? `${c.source} · on a Final/Export volume — never deleted`
                : c.source
            }
            path={c.abs_path}
            downloadHref={`/api/failures/duplicates/file?path=${encodeURIComponent(
              c.abs_path,
            )}`}
            canKeep={!lockedLibrary}
            keepTitle={lockedLibrary ? lockedHint : undefined}
            onKeep={() => onKeep(c.abs_path, c.abs_path)}
            // A view-only copy is never removed, so it gets neither the
            // checkbox nor the delete.
            selected={c.view_only ? undefined : sel.has(c.abs_path)}
            onToggleSel={c.view_only ? undefined : () => onToggleSel(c.abs_path)}
            onDelete={c.view_only ? undefined : () => onDeleteCopy(c.abs_path)}
            busy={busy}
          />
        ))}
      </div>

      {preview && existing && (
        <MediaViewer
          items={[
            {
              id: existing.id,
              filename:
                existing.filename ?? existing.abs_path ?? `#${existing.id}`,
              media_type: existing.media_type === "video" ? "video" : "photo",
              rel_path: existing.abs_path,
            },
          ]}
          index={0}
          onIndexChange={() => {}}
          onClose={() => setPreview(false)}
          renderActions={() => (
            <a
              className="btn"
              href={`/api/assets/${existing.id}/download`}
              download
            >
              Download
            </a>
          )}
        />
      )}
    </div>
  );
}

// A single copy within a group. The LIVE library copy gets no checkbox and no
// blind "delete" (removing it has to go through "Keep only this", which relinks
// the asset instead of leaving it pointing at nothing); a trashed one is already
// out of the library, so it gets a delete of its own. On-disk copies get the
// checkbox and the delete, plus the shared "Keep only this".
function MemberRow({
  label,
  zone,
  sub,
  primary,
  path,
  downloadHref,
  canKeep,
  keepTitle,
  onKeep,
  selected,
  onToggleSel,
  onDelete,
  deleteTitle = "Delete just this copy",
  busy,
}: {
  label: string;
  zone?: DuplicateZone;
  sub?: string;
  primary?: string;
  path: string;
  downloadHref: string;
  canKeep: boolean;
  keepTitle?: string;
  onKeep: () => void;
  selected?: boolean;
  onToggleSel?: () => void;
  onDelete?: () => void;
  deleteTitle?: string;
  busy: boolean;
}) {
  return (
    <div className={`dup-member${selected ? " selected" : ""}`}>
      {onToggleSel ? (
        <input
          type="checkbox"
          className="fail-check"
          checked={!!selected}
          onChange={onToggleSel}
          aria-label={`Select ${path}`}
        />
      ) : (
        <span className="fail-check" aria-hidden />
      )}
      <span className="pill dup-member-tag">{label}</span>
      {zone && <ZonePill zone={zone} />}
      <div className="dup-main">
        {primary && <div className="dup-cmp-name">{primary}</div>}
        <div className="dup-cmp-path">{path}</div>
        {sub && <div className="dup-sub">{sub}</div>}
      </div>
      <div className="dup-actions">
        <a
          className="btn btn-sm btn-icon"
          href={downloadHref}
          download
          title="Download this copy"
          aria-label="Download this copy"
        >
          {Icons.download}
        </a>
        {onDelete && (
          <button
            className="btn btn-sm btn-icon btn-danger"
            onClick={onDelete}
            disabled={busy}
            title={deleteTitle}
            aria-label={deleteTitle}
          >
            {Icons.trash}
          </button>
        )}
        <button
          className="btn btn-sm"
          onClick={onKeep}
          disabled={busy || !canKeep}
          title={keepTitle ?? "Keep only this copy and delete the others"}
        >
          {Icons.keep}
          <span>Keep only this</span>
        </button>
      </div>
    </div>
  );
}

// A false collision: distinct content that merely shares a partial hash with an
// indexed asset. It's already kept on its own, so there's nothing to keep/delete
// — just a download to inspect it and a note of what it collided with.
export function FalseCollisionRow({ it }: { it: DuplicateFalseItem }) {
  const dlHref = `/api/failures/duplicates/file?path=${encodeURIComponent(
    it.abs_path,
  )}`;
  return (
    <div className="dup-member">
      <span className="fail-check" aria-hidden />
      <span className="pill">false collision</span>
      <ZonePill zone={it.zone} />
      <div className="dup-main">
        <div className="dup-cmp-path">{it.abs_path}</div>
        <div className="dup-sub">
          {it.source} · distinct content, indexed separately
          {it.file_size != null ? ` · ${formatBytes(it.file_size)}` : ""} ·{" "}
          {it.content_hash.slice(0, 12)}…
        </div>
        {it.existing && (
          <div className="dup-cmp-path">
            shares a partial hash with #{it.existing.id} ·{" "}
            {it.existing.filename ?? it.existing.abs_path}
          </div>
        )}
      </div>
      <div className="dup-actions">
        <a
          className="btn btn-sm btn-icon"
          href={dlHref}
          download
          title="Download this file to inspect it"
          aria-label="Download this file"
        >
          {Icons.download}
        </a>
      </div>
    </div>
  );
}
