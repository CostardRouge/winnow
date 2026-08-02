"use client";

// Deduplication audit with hands-on triage. Copies of the same bytes are grouped
// by content; each group lists every place that content lives — the library’s
// indexed copy (if any) and the extra copies sitting on disk. We make no
// assumption about which is "the original": the user picks the survivor with
// "Keep only this" (the rest are deleted; the library entry is relinked onto the
// survivor when it's an on-disk copy), so a single media remains. A library copy
// that is already in the trash is a copy like any other — it can be picked, or
// dropped on its own with its row's Delete. A path filter (e.g. "trash") isolates
// a folder, and on-disk copies can still be culled one-at-a-time or by selection.
//
// One copy is never a candidate for removal: a Final/Export one. Those volumes
// are view-only across the app, so a copy there is shown locked — no delete, no
// checkbox — and when it's the library copy, it's the only survivor the group
// can be collapsed onto.
//
// False collisions — distinct content that merely shares a partial hash — are
// never grouped or collapsed; they're listed apart, for audit only.
import { useEffect, useMemo, useRef, useState } from "react";
import { Icons, LazyImage } from "../../../ui";
import MediaViewer from "../../../MediaViewer";
import { formatBytes } from "./model";
import type { DuplicateItem, ExistingAsset } from "./model";

// Whether a duplicate row is an exact copy we can safely collapse. A FALSE
// collision (verified === false) is distinct content that merely shares a
// partial hash; it gets indexed and kept on its own, so it is never grouped with
// — nor treated as a copy of — anything. Shown below for audit only.
const isIdentical = (it: DuplicateItem) => it.verified !== false;

// One group of byte-identical copies: the library-indexed copy (if any) plus
// every recorded on-disk copy of the same content. The user keeps exactly one.
type DupGroup = {
  hash: string;
  existing: ExistingAsset | null;
  copies: DuplicateItem[];
};

// A pending "keep only this" decision, surfaced in the confirm modal: the
// survivor, what gets deleted, and what happens to the library entry — relinked
// onto the survivor (a LIVE entry, when the survivor is an on-disk copy) or
// reclaimed (an entry already in the trash: its file goes, its row is stamped
// purged and stays hidden rather than being resurrected onto the survivor).
type KeepTarget = {
  hash: string;
  keepPath: string;
  keepLabel: string;
  deletions: string[];
  relink: boolean;
  reclaim: boolean;
};

export default function DedupSection({
  count,
  falseCollisions,
  items,
  onChanged,
  setMsg,
}: {
  count: number;
  falseCollisions: number;
  items: DuplicateItem[];
  onChanged: () => Promise<void> | void;
  setMsg: (s: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  // Pending confirmations: a list of on-disk paths to delete, a keep-one pick, or
  // a trashed library copy to drop on its own.
  const [confirm, setConfirm] = useState<string[] | null>(null);
  const [keep, setKeep] = useState<KeepTarget | null>(null);
  const [discard, setDiscard] = useState<ExistingAsset | null>(null);
  const [busy, setBusy] = useState(false);

  const needle = filter.trim().toLowerCase();

  // Group identical copies by content; keep false collisions aside (audit only).
  const { groups, falseItems } = useMemo(() => {
    const map = new Map<string, DupGroup>();
    const falses: DuplicateItem[] = [];
    for (const it of items) {
      if (!isIdentical(it)) {
        falses.push(it);
        continue;
      }
      let g = map.get(it.content_hash);
      if (!g) {
        g = { hash: it.content_hash, existing: it.existing, copies: [] };
        map.set(it.content_hash, g);
      }
      if (!g.existing && it.existing) g.existing = it.existing;
      g.copies.push(it);
    }
    return { groups: [...map.values()], falseItems: falses };
  }, [items]);

  const shownGroups = useMemo(
    () =>
      needle
        ? groups.filter(
            (g) =>
              (g.existing?.abs_path ?? "").toLowerCase().includes(needle) ||
              g.copies.some((c) => c.abs_path.toLowerCase().includes(needle)),
          )
        : groups,
    [groups, needle],
  );
  const shownFalse = needle
    ? falseItems.filter((it) => it.abs_path.toLowerCase().includes(needle))
    : falseItems;

  // Keep selection in sync with the copies still listed (rows vanish after a
  // delete/keep/refresh) so a stale path is never carried around.
  const sig = items.map((i) => i.abs_path).join("\n");
  useEffect(() => {
    const live = new Set(items.map((i) => i.abs_path));
    setSel((s) => {
      const next = new Set<string>();
      for (const p of s) if (live.has(p)) next.add(p);
      return next.size === s.size ? s : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  // Only on-disk copies are bulk-selectable; the indexed copy is removed via
  // "Keep only this" (which relinks the library entry), never a blind delete.
  // A copy on a view-only volume is out too — it is never deleted at all.
  const selectableShown = shownGroups.flatMap((g) =>
    g.copies.filter((c) => !c.view_only).map((c) => c.abs_path),
  );
  const allChecked =
    selectableShown.length > 0 && selectableShown.every((p) => sel.has(p));
  const someChecked = sel.size > 0 && !allChecked;
  const headRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (headRef.current) headRef.current.indeterminate = someChecked;
  }, [someChecked]);

  const toggleSel = (p: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });

  // Stage a "keep only this" decision: which copies would be deleted, and what
  // becomes of the library entry when it isn't the survivor — relinked onto the
  // survivor if it's live, reclaimed (file removed, row stamped purged) if it's
  // already in the trash. A purged entry has no bytes left and a view-only one
  // is never deleted, so neither ever appears among the deletions.
  const askKeep = (g: DupGroup, keepPath: string, keepLabel: string) => {
    const lib = g.existing;
    const libLoser = !!(lib?.abs_path && keepPath !== lib.abs_path);
    const members = [
      ...(lib?.abs_path && !lib.purged && !lib.view_only ? [lib.abs_path] : []),
      ...g.copies.filter((c) => !c.view_only).map((c) => c.abs_path),
    ];
    const deletions = members.filter((p) => p !== keepPath);
    setKeep({
      hash: g.hash,
      keepPath,
      keepLabel,
      deletions,
      relink: libLoser && !lib!.deleted,
      reclaim: libLoser && !!lib!.deleted,
    });
  };

  async function runDelete(paths: string[]) {
    setBusy(true);
    setMsg("");
    try {
      const r = await fetch("/api/failures/duplicates/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths }),
      });
      const d = await r.json();
      if (!r.ok) {
        setMsg(`Error: ${d.error ?? "unknown"}`);
      } else {
        const skipped = (d.skipped ?? []).length;
        setMsg(
          `Deleted ${d.deleted ?? 0} duplicate file(s).${
            skipped ? ` ${skipped} skipped (kept/protected).` : ""
          }`,
        );
      }
      setSel(new Set());
      setConfirm(null);
      await onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function runKeep(t: KeepTarget) {
    setBusy(true);
    setMsg("");
    try {
      const r = await fetch("/api/failures/duplicates/keep", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentHash: t.hash, keepPath: t.keepPath }),
      });
      const d = await r.json();
      if (!r.ok) {
        setMsg(`Error: ${d.error ?? "unknown"}`);
      } else {
        const skipped = (d.skipped ?? []).length;
        setMsg(
          `Kept 1 copy; deleted ${d.deleted ?? 0} file(s).${
            d.relinked ? " Library entry relinked to the copy you kept." : ""
          }${
            d.purged
              ? " The library entry was in the trash: its bytes are reclaimed and it stays there."
              : ""
          }${skipped ? ` ${skipped} skipped (protected).` : ""}`,
        );
      }
      setKeep(null);
      await onChanged();
    } finally {
      setBusy(false);
    }
  }

  // Drop every duplicate_hits row whose file is already gone from disk — the
  // case the app never gets a chance to clear on its own: a copy removed by
  // hand (e.g. straight from the incoming folder) rather than through
  // "Delete"/"Keep only this"/"Discard" above. Nothing on disk is touched;
  // only the stale audit row goes.
  async function runPurgeResolved() {
    setBusy(true);
    setMsg("");
    try {
      const r = await fetch("/api/failures/duplicates/purge-resolved", {
        method: "POST",
      });
      const d = await r.json();
      if (!r.ok) {
        setMsg(`Error: ${d.error ?? "unknown"}`);
      } else {
        setMsg(
          d.purged > 0
            ? `Cleared ${d.purged} entr${
                d.purged > 1 ? "ies" : "y"
              } whose file was already gone from disk (checked ${d.checked}).`
            : `Nothing to clear — every recorded file still exists on disk (checked ${d.checked}).`,
        );
      }
      await onChanged();
    } finally {
      setBusy(false);
    }
  }

  // Drop just the trashed library copy of a group, leaving the other extras
  // listed. Only offered for a copy already in the trash — a live one has to go
  // through "Keep only this", which relinks the entry instead of orphaning it.
  async function runDiscard(existing: ExistingAsset) {
    setBusy(true);
    setMsg("");
    try {
      const r = await fetch("/api/failures/duplicates/discard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assetId: existing.id }),
      });
      const d = await r.json();
      if (!r.ok) {
        setMsg(`Error: ${d.error ?? "unknown"}`);
      } else {
        setMsg(
          `Removed the trashed library copy #${existing.id}${
            d.deleted ? "" : " (its bytes were already gone)"
          }. It stays in the trash, marked purged.`,
        );
      }
      setDiscard(null);
      await onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={{ marginBottom: 28 }}>
      <div className="filterbar" style={{ marginBottom: 6 }}>
        {selectableShown.length > 0 && (
          <input
            ref={headRef}
            type="checkbox"
            className="fail-check"
            aria-label="Select all listed on-disk copies"
            checked={allChecked}
            onChange={(e) =>
              setSel(e.target.checked ? new Set(selectableShown) : new Set())
            }
          />
        )}
        <h3 style={{ margin: 0 }}>
          Deduplication <span className="hint">({count})</span>
        </h3>
        <span className="spacer" />
        <input
          className="input"
          style={{ maxWidth: 220 }}
          placeholder="Filter by path (e.g. trash)…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button
          className="btn"
          disabled={busy || count === 0}
          onClick={runPurgeResolved}
          title="Drop entries whose file no longer exists on disk — already resolved outside this page"
        >
          {Icons.reset}
          <span>Purge resolved</span>
        </button>
        <button
          className="btn btn-danger"
          disabled={busy || sel.size === 0}
          onClick={() => setConfirm([...sel])}
        >
          {Icons.trash}
          <span>Delete selected ({sel.size})</span>
        </button>
      </div>
      <p className="hint" style={{ marginTop: 0 }}>
        Files matched as duplicates by partial hash, grouped by content. Each
        group holds the same bytes in more than one place — the library’s copy
        and any extra copies on disk. Winnow doesn’t assume which is the original:
        pick the one to keep with <strong>“Keep only this”</strong> and the rest
        are removed (the library entry is relinked onto your pick if it’s an
        on-disk copy), leaving a single media. A library copy already in the
        trash is never relinked: its file is removed and the entry marked purged
        — and it can be dropped on its own with its row’s delete. Copies on a{" "}
        <strong>Final or Export volume are never deleted</strong>: those masters
        are view-only, so they’re shown locked and are the copy the group
        collapses onto. False collisions — genuinely distinct content that merely
        shares a partial hash — are indexed separately and never collapsed;
        they’re listed below for audit only.
        {falseCollisions > 0
          ? ` ${falseCollisions} false collision(s) recovered.`
          : ""}{" "}
        A copy removed by hand outside this page (e.g. straight from incoming)
        leaves its row behind claiming a file that’s already gone —{" "}
        <strong>“Purge resolved”</strong> re-checks every entry on disk and
        drops the ones already gone; nothing on disk is touched.
      </p>

      {count === 0 ? (
        <div className="empty" style={{ padding: 16 }}>
          Nothing here. 🎉
        </div>
      ) : shownGroups.length === 0 && shownFalse.length === 0 ? (
        <div className="empty" style={{ padding: 16 }}>
          No duplicate matches “{filter}”.
        </div>
      ) : (
        <div className="dup-groups">
          {shownGroups.map((g) => (
            <DupGroupCard
              key={g.hash}
              group={g}
              sel={sel}
              onToggleSel={toggleSel}
              onKeep={(p, label) => askKeep(g, p, label)}
              onDeleteCopy={(p) => setConfirm([p])}
              onDiscardLibrary={setDiscard}
              busy={busy}
            />
          ))}
          {shownFalse.length > 0 && (
            <div className="dup-false">
              <div className="dup-false-head">
                Distinct content (false collisions) — kept, audit only
              </div>
              {shownFalse.map((it) => (
                <FalseCollisionRow key={it.abs_path} it={it} />
              ))}
            </div>
          )}
        </div>
      )}

      {confirm && (
        <ConfirmDeleteModal
          paths={confirm}
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => runDelete(confirm)}
        />
      )}
      {keep && (
        <ConfirmKeepModal
          target={keep}
          busy={busy}
          onCancel={() => setKeep(null)}
          onConfirm={() => runKeep(keep)}
        />
      )}
      {discard && (
        <ConfirmDiscardModal
          existing={discard}
          busy={busy}
          onCancel={() => setDiscard(null)}
          onConfirm={() => runDiscard(discard)}
        />
      )}
    </section>
  );
}

// One content group: a thumbnail header (the bytes are identical, so the
// library copy's thumbnail stands in for the whole group) over a flat list of
// every place that content lives — the library copy first (if any), then each
// on-disk copy. Every member can be downloaded and chosen as the survivor.
function DupGroupCard({
  group,
  sel,
  onToggleSel,
  onKeep,
  onDeleteCopy,
  onDiscardLibrary,
  busy,
}: {
  group: DupGroup;
  sel: Set<string>;
  onToggleSel: (p: string) => void;
  onKeep: (keepPath: string, keepLabel: string) => void;
  onDeleteCopy: (p: string) => void;
  onDiscardLibrary: (existing: ExistingAsset) => void;
  busy: boolean;
}) {
  const { existing, copies, hash } = group;
  const thumb = existing?.has_thumb ? `/api/assets/${existing.id}/thumb` : null;
  const size = copies.find((c) => c.file_size != null)?.file_size ?? null;
  const total = (existing ? 1 : 0) + copies.length;
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
            {thumb ? (
              <LazyImage src={thumb} alt="" />
            ) : (
              <span className="pl-thumb-empty">{Icons.photos}</span>
            )}
          </div>
        )}
        <div className="dup-main">
          <div className="dup-path">
            {total} identical {total === 1 ? "copy" : "copies"}
          </div>
          <div className="dup-sub">
            {size != null ? `${formatBytes(size)} each · ` : ""}
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
            onToggleSel={
              c.view_only ? undefined : () => onToggleSel(c.abs_path)
            }
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
              filename: existing.filename ?? existing.abs_path ?? `#${existing.id}`,
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
function FalseCollisionRow({ it }: { it: DuplicateItem }) {
  const dlHref = `/api/failures/duplicates/file?path=${encodeURIComponent(
    it.abs_path,
  )}`;
  return (
    <div className="dup-member">
      <span className="fail-check" aria-hidden />
      <span className="pill">false collision</span>
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

function ConfirmKeepModal({
  target,
  busy,
  onCancel,
  onConfirm,
}: {
  target: KeepTarget;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const n = target.deletions.length;
  return (
    <div className="modal-overlay" onClick={onCancel} role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Keep one copy"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title">Keep only this copy?</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          Keeping <strong className="dup-cmp-name">{target.keepLabel}</strong>.{" "}
          {n === 0
            ? "Nothing else to remove."
            : `The other ${n} identical file${
                n > 1 ? "s" : ""
              } below will be permanently removed from disk.`}{" "}
          {target.relink
            ? "The library entry (rating, tags, derivatives) is relinked onto the copy you keep — the original file it currently points at is the one being deleted."
            : ""}
          {target.reclaim
            ? "The library entry is already in the trash, so it isn’t relinked onto your pick: its file is removed and the entry is marked purged, staying in the trash where you put it."
            : ""}{" "}
          This is irreversible.
        </p>
        {n > 0 && (
          <div className="dup-confirm-list">
            {target.deletions.slice(0, 12).map((p) => (
              <div key={p} className="dup-cmp-path">
                {p}
              </div>
            ))}
            {n > 12 && <div className="hint">…and {n - 12} more.</div>}
          </div>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-danger" onClick={onConfirm} disabled={busy}>
            {busy ? "Working…" : "Keep only this"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Removing a group's library copy when it is already in the trash: its file goes
// and the entry is stamped purged, but the row itself survives (audit + export
// lineage) and stays hidden, exactly like a purge. The other copies in the group
// are untouched.
function ConfirmDiscardModal({
  existing,
  busy,
  onCancel,
  onConfirm,
}: {
  existing: ExistingAsset;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-overlay" onClick={onCancel} role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Delete the trashed library copy"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title">Delete this trashed copy’s file?</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          <strong className="dup-cmp-name">
            #{existing.id} · {existing.filename ?? existing.abs_path}
          </strong>{" "}
          is already in the trash — only its file is still taking up space. It
          will be permanently removed from disk and the entry marked purged; it
          stays in the trash and the other copies in this group are left as they
          are. This is irreversible.
        </p>
        <div className="dup-confirm-list">
          <div className="dup-cmp-path">{existing.abs_path}</div>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-danger" onClick={onConfirm} disabled={busy}>
            {busy ? "Deleting…" : "Delete the file"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ConfirmDeleteModal({
  paths,
  busy,
  onCancel,
  onConfirm,
}: {
  paths: string[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const n = paths.length;
  return (
    <div className="modal-overlay" onClick={onCancel} role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Delete duplicate files"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title">
          Delete {n} duplicate file{n > 1 ? "s" : ""}?
        </h2>
        <p className="hint" style={{ marginTop: 0 }}>
          The extra cop{n > 1 ? "ies" : "y"} below will be permanently removed
          from disk. The kept, indexed original is untouched. This is
          irreversible.
        </p>
        <div className="dup-confirm-list">
          {paths.slice(0, 12).map((p) => (
            <div key={p} className="dup-cmp-path">
              {p}
            </div>
          ))}
          {n > 12 && <div className="hint">…and {n - 12} more.</div>}
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-danger" onClick={onConfirm} disabled={busy}>
            {busy ? "Deleting…" : `Delete ${n} file${n > 1 ? "s" : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}
