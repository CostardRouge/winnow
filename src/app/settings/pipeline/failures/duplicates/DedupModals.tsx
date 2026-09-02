"use client";

// The confirmations of the deduplication page. Every one of them removes bytes
// that cannot come back, so each states exactly what goes, what survives, and
// what happens to the library entry — before the button, not after.
import { formatBytes } from "../model";
import { useOverlayDismiss } from "../../../../useOverlayDismiss";
import type { DuplicateExisting } from "@/lib/duplicateTypes";

// A pending "keep only this" decision: the survivor, what gets deleted, and what
// happens to the library entry — relinked onto the survivor (a LIVE entry, when
// the survivor is an on-disk copy) or reclaimed (an entry already in the trash:
// its file goes, its row is stamped purged and stays hidden rather than being
// resurrected onto the survivor).
export type KeepTarget = {
  hash: string;
  keepPath: string;
  keepLabel: string;
  deletions: string[];
  relink: boolean;
  reclaim: boolean;
};

// What a bulk auto-resolve would do, computed server-side from the same filter
// the list is showing.
export type AutoTarget = {
  groups: number;
  reclaimable: number;
  scopeLabel: string;
};

function Modal({
  label,
  title,
  onCancel,
  children,
}: {
  label: string;
  title: string;
  onCancel: () => void;
  children: React.ReactNode;
}) {
  const backdrop = useOverlayDismiss<HTMLDivElement>(onCancel);
  return (
    <div className="modal-overlay" role="presentation" {...backdrop}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={label}>
        <h2 className="modal-title">{title}</h2>
        {children}
      </div>
    </div>
  );
}

function PathList({ paths }: { paths: string[] }) {
  const n = paths.length;
  return (
    <div className="dup-confirm-list">
      {paths.slice(0, 12).map((p) => (
        <div key={p} className="dup-cmp-path">
          {p}
        </div>
      ))}
      {n > 12 && <div className="hint">…and {n - 12} more.</div>}
    </div>
  );
}

export function ConfirmKeepModal({
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
    <Modal label="Keep one copy" title="Keep only this copy?" onCancel={onCancel}>
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
      {n > 0 && <PathList paths={target.deletions} />}
      <div className="modal-actions">
        <button className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button className="btn btn-danger" onClick={onConfirm} disabled={busy}>
          {busy ? "Working…" : "Keep only this"}
        </button>
      </div>
    </Modal>
  );
}

// Removing a group's library copy when it is already in the trash: its file goes
// and the entry is stamped purged, but the row itself survives (audit + export
// lineage) and stays hidden, exactly like a purge. The other copies in the group
// are untouched.
export function ConfirmDiscardModal({
  existing,
  busy,
  onCancel,
  onConfirm,
}: {
  existing: DuplicateExisting;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      label="Delete the trashed library copy"
      title="Delete this trashed copy’s file?"
      onCancel={onCancel}
    >
      <p className="hint" style={{ marginTop: 0 }}>
        <strong className="dup-cmp-name">
          #{existing.id} · {existing.filename ?? existing.abs_path}
        </strong>{" "}
        is already in the trash — only its file is still taking up space. It will
        be permanently removed from disk and the entry marked purged; it stays in
        the trash and the other copies in this group are left as they are. This is
        irreversible.
      </p>
      <PathList paths={[existing.abs_path ?? "(path unknown)"]} />
      <div className="modal-actions">
        <button className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button className="btn btn-danger" onClick={onConfirm} disabled={busy}>
          {busy ? "Deleting…" : "Delete the file"}
        </button>
      </div>
    </Modal>
  );
}

export function ConfirmDeleteModal({
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
    <Modal
      label="Delete duplicate files"
      title={`Delete ${n} duplicate file${n > 1 ? "s" : ""}?`}
      onCancel={onCancel}
    >
      <p className="hint" style={{ marginTop: 0 }}>
        The extra cop{n > 1 ? "ies" : "y"} below will be permanently removed from
        disk. The kept, indexed original is untouched. This is irreversible.
      </p>
      <PathList paths={paths} />
      <div className="modal-actions">
        <button className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button className="btn btn-danger" onClick={onConfirm} disabled={busy}>
          {busy ? "Deleting…" : `Delete ${n} file${n > 1 ? "s" : ""}`}
        </button>
      </div>
    </Modal>
  );
}

// The bulk collapse. Nothing here names individual files — the whole point is
// that there are thousands — so the modal has to be precise about the RULE
// instead, since that is what the user is actually agreeing to.
export function ConfirmAutoModal({
  target,
  progress,
  busy,
  onCancel,
  onConfirm,
}: {
  target: AutoTarget;
  progress: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      label="Resolve duplicate groups automatically"
      title={`Collapse ${target.groups.toLocaleString()} group${
        target.groups > 1 ? "s" : ""
      }?`}
      onCancel={onCancel}
    >
      <p className="hint" style={{ marginTop: 0 }}>
        Every group in <strong>{target.scopeLabel}</strong> whose survivor is not
        a judgement call will be collapsed onto that survivor, freeing about{" "}
        <strong>{formatBytes(target.reclaimable)}</strong>. Two rules, in order:
      </p>
      <ul className="hint dup-rule-list">
        <li>
          a group with exactly one copy on a <strong>Final or Export</strong>{" "}
          volume keeps that copy — those masters are view-only, so the other
          copies are the only ones deduplication could remove anyway;
        </li>
        <li>
          otherwise the <strong>live library entry</strong> keeps its file and
          the extra on-disk copies go.
        </li>
      </ul>
      <p className="hint">
        Everything else is left alone: a group with two protected copies, one
        whose library entry is in the trash, and one made only of on-disk copies
        all need you to say which folder should hold the file. Deletions are
        permanent.
        {progress ? ` ${progress}` : ""}
      </p>
      <div className="modal-actions">
        {/* Never disabled: mid-run it becomes the abort, which is the only way
            out of a batch loop that can take minutes. */}
        <button className="btn" onClick={onCancel}>
          {busy ? "Stop" : "Cancel"}
        </button>
        <button className="btn btn-danger" onClick={onConfirm} disabled={busy}>
          {busy ? "Working…" : "Collapse them"}
        </button>
      </div>
    </Modal>
  );
}
