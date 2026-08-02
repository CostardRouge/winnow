"use client";

// Failures › Analyze: photo/video derivative generation that errored. Retry is
// available per item, by selection, or family-wide; Delete is the escape hatch
// for an asset that can never be re-derived (soft delete → trash, never touches
// a file on disk).
import { useState } from "react";
import type { RowData } from "../model";
import { useFailures } from "../useFailures";
import { FamilyShell, RetrySection } from "../sections";

export default function AnalyzeFailuresPage() {
  const { data, error, busy, setBusy, msg, setMsg, load, doRetry } =
    useFailures();
  const count = data?.derivative.count ?? 0;

  const rows: RowData<number>[] = (data?.derivative.items ?? []).map((it) => ({
    key: it.asset_id,
    title: `#${it.asset_id} · ${it.filename} (${it.media_type})`,
    path: it.abs_path,
    error: it.error ?? "—",
    when: it.updated_at,
    downloadHref: `/api/assets/${it.asset_id}/download`,
  }));

  const onRetry = (keys: number[] | null, busyKey: string) =>
    doRetry("derivative", keys ? { ids: keys } : {}, busyKey);

  // Delete broken derivatives (soft delete → trash): staged behind a
  // confirmation. `null` keys = every derivative-error asset (server-side
  // filter, beyond the listing cap); otherwise the picked ids.
  const [confirmDelete, setConfirmDelete] = useState<{
    ids: number[] | null;
    count: number;
  } | null>(null);
  const onDelete = (keys: number[] | null) =>
    setConfirmDelete({ ids: keys, count: keys?.length ?? count });

  async function runDelete() {
    if (!confirmDelete || busy) return;
    setBusy("derivative:delete");
    setMsg("");
    try {
      // ids for a pick, a filter for "all" (covers rows past the 200 cap). Soft
      // delete only: never touches a file, so it's safe even on Final volumes.
      const body = confirmDelete.ids
        ? { ids: confirmDelete.ids }
        : { filter: { derivative_status: ["error"] } };
      const r = await fetch("/api/assets/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      setMsg(
        r.ok
          ? `Moved ${d.updated ?? 0} broken media to the trash. Reclaim the space (and the leftover thumbnails) with Empty trash.`
          : `Error: ${d.error ?? "unknown"}`,
      );
      setConfirmDelete(null);
      await load();
    } finally {
      setBusy(null);
    }
  }

  return (
    <FamilyShell onRefresh={load} error={error} msg={msg}>
      <RetrySection<number>
        title="Analyze (derivatives)"
        hint="Photo/video derivative generation failed — check the message, fix the cause (e.g. ffmpeg/codec), then retry. If it can never be rebuilt (the original was deleted, or it's a junk/@eaDir file that shouldn't have been indexed), Delete moves it to the trash — safe even on Final volumes, since it never touches a file."
        count={count}
        rows={rows}
        retryAllLabel="Retry all"
        prefix="derivative"
        busy={busy}
        onRetry={onRetry}
        onDelete={onDelete}
      />

      {confirmDelete && (
        <ConfirmTrashModal
          count={confirmDelete.count}
          all={confirmDelete.ids === null}
          busy={busy === "derivative:delete"}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={runDelete}
        />
      )}
    </FamilyShell>
  );
}

// Confirms moving broken derivatives to the trash. Deliberately reassuring: a
// soft delete only sets `deleted_at`, so it never touches a file on disk — the
// safe answer to "these are in a Final (view-only) volume and I've already
// deleted the originals". Reversible from the Trash tab; Empty trash then drops
// the leftover derivatives and reclaims the row.
function ConfirmTrashModal({
  count,
  all,
  busy,
  onCancel,
  onConfirm,
}: {
  count: number;
  all: boolean;
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
        aria-label="Move broken media to trash"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title">
          Move {count} broken {count > 1 ? "media" : "medium"} to the trash?
        </h2>
        <p className="hint" style={{ marginTop: 0 }}>
          {all
            ? "Every media currently in derivative error"
            : `The ${count} selected media`}{" "}
          will be <strong>soft-deleted</strong>: hidden from the gallery and
          sessions. This <strong>never touches a file on disk</strong> — safe
          even on Final (view-only) volumes, and it&rsquo;s the right move when
          the originals are already gone. It&rsquo;s <strong>reversible</strong>{" "}
          from the Trash tab; <em>Empty trash</em> afterwards drops the leftover
          thumbnails/proxies and reclaims the rows for good.
        </p>
        <div className="modal-actions">
          <button className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-danger" onClick={onConfirm} disabled={busy}>
            {busy ? "Working…" : `Move ${count} to trash`}
          </button>
        </div>
      </div>
    </div>
  );
}
