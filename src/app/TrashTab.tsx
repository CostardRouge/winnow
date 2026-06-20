"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchJson } from "@/lib/fetchJson";
import {
  deleteAssets,
  deleteAssetsByFilter,
  purgeTrash,
} from "@/lib/assetActions";
import { formatBytes } from "@/lib/format";
import { SkeletonCards, EmptyState, LazyImage, ConfirmDialog } from "./ui";

// 40px trash glyph for the empty state (the shared Icons.trash is a 16px inline
// action icon — too small here, where it sits beside 40px empty-state glyphs).
const TrashGlyph = (
  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 6h18" />
    <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
    <path d="M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6" />
    <path d="M10 11v6M14 11v6" />
  </svg>
);

// Trash tab — the reclaiming end of the "winnowing".
//
// Soft-delete (the gallery/viewer "Delete") is a recycle bin: hidden but the NAS
// original is untouched, so nothing is lost AND nothing is freed. This tab makes
// the loop actually reclaim space:
//   - "Move all rejects to trash" → one click to bin every rejected shot;
//   - per-item / "Restore all"    → undo while still in the bin;
//   - "Empty trash — reclaim X"   → confirmed, irreversible purge that removes
//     the originals + derivatives and frees the disk.

type PurgeResult = {
  total?: number;
  purged?: number;
  freed_bytes?: number;
  skipped?: number;
  error_count?: number;
  errors?: unknown[];
  error?: string;
} | null;

type PurgeJob = {
  id: number;
  status: string;
  result: PurgeResult;
  created_at: string;
  finished_at: string | null;
};

type Summary = {
  enabled: boolean;
  trash: { count: number; bytes: number };
  rejects: { count: number; bytes: number };
  purged: { count: number };
  jobs: PurgeJob[];
};

type TrashAsset = {
  id: number;
  filename: string;
  ext: string;
  media_type: "photo" | "video";
  file_size: number | null;
  derivative_status: string;
};

function statusPill(status: string): string {
  if (status === "done") return "ready";
  if (status === "error") return "error";
  return "pending";
}

export default function TrashTab() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [items, setItems] = useState<TrashAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmPurge, setConfirmPurge] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, a] = await Promise.all([
        fetchJson<Summary>("/api/trash"),
        fetchJson<{ assets?: TrashAsset[] }>("/api/assets?deleted=trash"),
      ]);
      setSummary(s);
      setItems(a.assets ?? []);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // While a purge is queued/running, follow its progress.
  const jobActive = useMemo(
    () => summary?.jobs.some((j) => j.status === "queued" || j.status === "running"),
    [summary],
  );
  useEffect(() => {
    if (!jobActive) return;
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, [jobActive, load]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(t);
  }, [notice]);

  async function moveRejects() {
    if (!summary?.rejects.count) return;
    setBusy("reject");
    try {
      const n = await deleteAssetsByFilter({ verdict: "reject" });
      setNotice(`${n} reject${n === 1 ? "" : "s"} moved to trash`);
      await load();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function restoreOne(id: number) {
    // Optimistic: drop it from the preview immediately; reload (or roll back) after.
    setItems((prev) => prev.filter((a) => a.id !== id));
    try {
      await deleteAssets([id], true);
    } catch (e) {
      setNotice((e as Error).message);
    }
    await load();
  }

  async function restoreAll() {
    if (!summary?.trash.count) return;
    setBusy("restore");
    try {
      const n = await deleteAssetsByFilter({}, true);
      setNotice(`${n} restored to the library`);
      await load();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function emptyTrash() {
    setBusy("purge");
    try {
      await purgeTrash({});
      setConfirmPurge(false);
      setNotice("Purge queued — reclaiming space…");
      await load();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const trashCount = summary?.trash.count ?? 0;
  const trashBytes = summary?.trash.bytes ?? 0;
  const rejectCount = summary?.rejects.count ?? 0;
  const purgeEnabled = summary?.enabled ?? true;

  return (
    <div className="tab-pane sessions-pane">
      {error && (
        <div className="error-box">
          <span>Couldn’t load the trash: {error}</span>
          <button className="btn" onClick={load}>
            Retry
          </button>
        </div>
      )}

      {loading ? (
        <SkeletonCards rows={2} />
      ) : (
        <>
          <div className="trash-head">
            <div className="trash-stat">
              <span className="trash-stat-num">{trashCount}</span>
              <span className="trash-stat-label">
                in trash · {formatBytes(trashBytes)} reclaimable
              </span>
            </div>
            <span className="spacer" />
            {notice && <span className="notice">{notice}</span>}
            <button
              className="btn"
              onClick={moveRejects}
              disabled={!rejectCount || busy === "reject"}
              title="Soft-delete every rejected shot still in the library"
            >
              {busy === "reject" ? "…" : `Move rejects to trash (${rejectCount})`}
            </button>
            <button
              className="btn"
              onClick={restoreAll}
              disabled={!trashCount || busy === "restore"}
            >
              {busy === "restore" ? "…" : "Restore all"}
            </button>
            <button
              className="btn btn-reject"
              onClick={() => setConfirmPurge(true)}
              disabled={!trashCount || !purgeEnabled}
              title={
                purgeEnabled
                  ? "Permanently delete the originals to free space"
                  : "Purge is disabled (PURGE_ENABLED=false)"
              }
            >
              🗑 Empty trash{trashBytes ? ` — reclaim ${formatBytes(trashBytes)}` : ""}
            </button>
          </div>

          {!purgeEnabled && trashCount > 0 && (
            <div className="trash-hint">
              Purging is disabled on this instance (<code>PURGE_ENABLED=false</code>).
              Items stay in the recycle bin; set it to <code>true</code> to reclaim
              space.
            </div>
          )}

          {trashCount === 0 ? (
            <EmptyState
              icon={TrashGlyph}
              title="Trash is empty"
              hint={
                rejectCount
                  ? `${rejectCount} rejected shot${rejectCount === 1 ? "" : "s"} in the library. Move them to the trash, then empty it to reclaim the space.`
                  : "Reject shots while culling, then bin them here to slim the archive down. Soft-deleted items land here first — recoverable until you empty the trash."
              }
            />
          ) : (
            <div className="trash-grid">
              {items.map((a) => (
                <div key={a.id} className="trash-cell">
                  {a.derivative_status === "ready" ? (
                    <LazyImage src={`/api/assets/${a.id}/thumb`} alt={a.filename} />
                  ) : (
                    <div className="trash-cell-ph">{a.ext.replace(".", "")}</div>
                  )}
                  <span className="trash-cell-size">{formatBytes(a.file_size)}</span>
                  <button
                    className="trash-restore"
                    title="Restore to the library"
                    onClick={() => restoreOne(a.id)}
                  >
                    ↺
                  </button>
                </div>
              ))}
              {trashCount > items.length && (
                <div className="trash-cell trash-more">
                  +{trashCount - items.length}
                  <span>more</span>
                </div>
              )}
            </div>
          )}

          {summary && summary.jobs.length > 0 && (
            <div className="trash-jobs">
              <div className="trash-jobs-title">Recent purges</div>
              {summary.jobs.map((j) => {
                const r = j.result;
                const freed = r?.freed_bytes ? formatBytes(r.freed_bytes) : null;
                const errs =
                  r?.error_count ??
                  (Array.isArray(r?.errors) ? r!.errors!.length : 0);
                const skipped = r?.skipped ?? 0;
                return (
                  <div key={j.id} className="trash-job">
                    <span className={`pill ${statusPill(j.status)}`}>{j.status}</span>
                    <span className="meta">
                      {r?.purged != null ? `${r.purged}/${r.total ?? r.purged} freed` : "queued"}
                      {freed ? ` · ${freed} reclaimed` : ""}
                      {errs ? ` · ${errs} couldn’t be freed` : ""}
                      {skipped ? ` · ${skipped} skipped` : ""}
                      {r?.error ? ` · ${r.error}` : ""}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      <ConfirmDialog
        open={confirmPurge}
        danger
        busy={busy === "purge"}
        title="Empty the trash?"
        confirmLabel={`Reclaim ${formatBytes(trashBytes)}`}
        requireAck="I understand the originals are permanently deleted from the NAS and this can't be undone."
        message={
          <>
            This permanently removes <strong>{trashCount}</strong> original
            {trashCount === 1 ? "" : "s"} (<strong>{formatBytes(trashBytes)}</strong>)
            and their cached previews to free space on the NAS. Restore anything you
            want to keep first — after this they’re gone.
          </>
        }
        onConfirm={emptyTrash}
        onCancel={() => setConfirmPurge(false)}
      />
    </div>
  );
}
