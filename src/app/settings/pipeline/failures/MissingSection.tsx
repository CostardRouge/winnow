"use client";

// Missing originals (cf. lib/integrity.ts): indexed assets whose file is gone
// from disk. The detector already auto-trashed them (reversible, `trashed`) —
// or only flagged them when a mass disappearance looked like an unmounted
// volume. Triage here:
//   - Re-check : re-stats the selection; whichever files answer again are
//     restored automatically (flag + auto-trash lifted).
//   - Restore  : puts the asset back in the library anyway (e.g. the detection
//     is known-wrong and the file will be back later).
//   - Purge    : the irreversible cleanup — drops the leftover derivatives and
//     stamps the row purged (there is no original left to lose). A row that a
//     purge refused keeps its reason (`purge_error`) visible on the row.
//   - Verify integrity : queues the full sweep (sources + derivative objects).
import { useEffect, useRef, useState } from "react";
import { Icons } from "../../../ui";
import { formatBytes } from "./model";
import type { MissingItem } from "./model";

// What a finished purge job reports back (cf. lib/purge.ts runPurgeJob).
type PurgeResult = {
  requested?: number | null;
  total?: number;
  purged?: number;
  skipped?: number;
  error_count?: number;
  errors?: { asset_id: number; abs_path: string; error: string }[];
  error?: string;
};

// Poll a queued purge job until it finishes, and turn its result into one
// sentence the user can act on. Queuing succeeds even when every row will be
// refused (view-only volume, unreadable folder…) or when nothing was still in
// the trash — reporting "queued" as if it were done is what made a stuck purge
// look like a dead button.
const PURGE_POLL_MS = 1500;
const PURGE_POLL_TRIES = 20; // ~30s, then the 5s list refresh takes over

async function followPurgeJob(
  jobId: number | undefined,
  requested: number,
): Promise<string> {
  if (!jobId) return `Purge queued for ${requested} asset(s).`;
  for (let i = 0; i < PURGE_POLL_TRIES; i++) {
    await new Promise((r) => setTimeout(r, PURGE_POLL_MS));
    let job: { status: string; result: PurgeResult | null } | undefined;
    try {
      const res = await fetch(`/api/purge?job_id=${jobId}`);
      if (!res.ok) continue;
      job = (await res.json()).job;
    } catch {
      continue; // transient: keep polling
    }
    if (!job || job.status === "queued" || job.status === "running") continue;
    const r = job.result ?? {};
    if (job.status === "error")
      return `Purge failed: ${r.error ?? "unknown error"}. Nothing was removed.`;
    const purged = r.purged ?? 0;
    const refused = r.error_count ?? 0;
    if (refused)
      return `Purged ${purged}/${requested} — ${refused} refused: ${
        r.errors?.[0]?.error ?? "see the reason on each row"
      }. The reason is shown on every remaining row.`;
    if (!purged)
      return `Nothing purged: none of the ${requested} selected asset(s) were still in the trash (restored or already purged meanwhile).`;
    return `Purged ${purged} asset(s): leftover derivatives removed, rows stamped purged.`;
  }
  return "The purge is still running — the rows will disappear as they are freed (check Trash › Recent purges if it stays).";
}

export default function MissingSection({
  count,
  items,
  onChanged,
  setMsg,
}: {
  count: number;
  items: MissingItem[];
  onChanged: () => Promise<void> | void;
  setMsg: (s: string) => void;
}) {
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmPurge, setConfirmPurge] = useState<MissingItem[] | null>(null);

  // Prune the selection as rows resolve (re-checked back / purged away).
  const sig = items.map((i) => i.asset_id).join(" ");
  useEffect(() => {
    const live = new Set(items.map((i) => i.asset_id));
    setSel((s) => {
      const next = new Set<number>();
      for (const id of s) if (live.has(id)) next.add(id);
      return next.size === s.size ? s : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  const allChecked = items.length > 0 && sel.size === items.length;
  const someChecked = sel.size > 0 && !allChecked;
  const headRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (headRef.current) headRef.current.indeterminate = someChecked;
  }, [someChecked]);

  const toggle = (id: number) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const anyBusy = busy !== null;
  const targets = (ids?: number[]) =>
    ids?.length ? items.filter((i) => ids.includes(i.asset_id)) : items;

  async function recheck(ids: number[] | null, busyKey: string) {
    if (anyBusy) return;
    setBusy(busyKey);
    setMsg("");
    try {
      const r = await fetch("/api/failures/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "missing", ...(ids ? { ids } : {}) }),
      });
      const d = await r.json();
      setMsg(
        r.ok
          ? `Re-checked. ${d.retried ?? 0} file(s) are back and were restored; the rest are still gone.`
          : `Error: ${d.error ?? "unknown"}`,
      );
      setSel(new Set());
      await onChanged();
    } finally {
      setBusy(null);
    }
  }

  async function restore(ids: number[], busyKey: string) {
    if (anyBusy || !ids.length) return;
    setBusy(busyKey);
    setMsg("");
    try {
      const r = await fetch("/api/assets/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, restore: true }),
      });
      const d = await r.json();
      setMsg(
        r.ok
          ? `Restored ${d.updated ?? 0} asset(s) to the library (files still missing — they'll show as broken until the file is back).`
          : `Error: ${d.error ?? "unknown"}`,
      );
      setSel(new Set());
      await onChanged();
    } finally {
      setBusy(null);
    }
  }

  async function purge(list: MissingItem[]) {
    setBusy("missing:purge");
    setMsg("");
    try {
      const ids = list.map((i) => i.asset_id);
      // The purge worker only operates on the trash: flagged-but-live rows
      // (mass-disappearance guard) are soft-deleted first, then purged.
      const flagged = list.filter((i) => !i.trashed).map((i) => i.asset_id);
      if (flagged.length) {
        const r1 = await fetch("/api/assets/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: flagged }),
        });
        if (!r1.ok) {
          const d1 = await r1.json();
          setMsg(`Error: ${d1.error ?? "unknown"}`);
          return;
        }
      }
      const r = await fetch("/api/purge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filter: { ids } }),
      });
      const d = await r.json();
      if (!r.ok) {
        setMsg(`Error: ${d.error ?? "unknown"}`);
        return;
      }
      setSel(new Set());
      setConfirmPurge(null);
      setMsg(`Purge queued for ${ids.length} asset(s)…`);
      // Queued ≠ done: follow the job to its result, so a purge that refused
      // every row says so instead of silently leaving the list unchanged.
      setMsg(await followPurgeJob(d.purge_job_id, ids.length));
      await onChanged();
    } finally {
      setBusy(null);
    }
  }

  async function verifyIntegrity() {
    if (anyBusy) return;
    setBusy("missing:verify");
    setMsg("");
    try {
      const r = await fetch("/api/integrity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const d = await r.json();
      setMsg(
        r.ok
          ? "Integrity sweep queued: every original is re-checked on disk and every derivative in storage. Watch this tab as results land."
          : `Error: ${d.error ?? "unknown"}`,
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <section style={{ marginBottom: 28 }}>
      <div className="filterbar" style={{ marginBottom: 6 }}>
        {count > 0 && (
          <input
            ref={headRef}
            type="checkbox"
            className="fail-check"
            aria-label="Select all — missing files"
            checked={allChecked}
            onChange={(e) =>
              setSel(
                e.target.checked
                  ? new Set(items.map((i) => i.asset_id))
                  : new Set(),
              )
            }
          />
        )}
        <h3 style={{ margin: 0 }}>
          Missing files <span className="hint">({count})</span>
        </h3>
        <span className="spacer" />
        <button
          className="btn"
          onClick={verifyIntegrity}
          disabled={anyBusy}
          title="Queue a full sweep: re-check every original on disk and every derivative in storage"
        >
          {busy === "missing:verify" ? "…" : "Verify integrity"}
        </button>
        <button
          className="btn"
          onClick={() => recheck(sel.size ? [...sel] : null, "missing:recheck")}
          disabled={anyBusy || count === 0}
        >
          {busy === "missing:recheck"
            ? "…"
            : sel.size
              ? `Re-check selected (${sel.size})`
              : "Re-check all"}
        </button>
        <button
          className="btn btn-danger"
          onClick={() =>
            setConfirmPurge(targets(sel.size ? [...sel] : undefined))
          }
          disabled={anyBusy || count === 0}
        >
          {Icons.trash}
          <span>{sel.size ? `Purge selected (${sel.size})` : "Purge all"}</span>
        </button>
      </div>
      <p className="hint" style={{ marginTop: 0 }}>
        Indexed media whose original file is <strong>no longer on disk</strong>{" "}
        (deleted by hand, cleaned-up empties…). They were moved to the trash
        automatically (reversible) so they leave the gallery and sessions —
        except mass disappearances, flagged only, in case a volume was merely
        unmounted. <strong>Re-check</strong> restores whatever answers again;{" "}
        <strong>Purge</strong> is the irreversible cleanup (removes the leftover
        derivatives, keeps the row for audit).
      </p>
      {count === 0 ? (
        <div className="empty" style={{ padding: 16 }}>
          Nothing here. 🎉
        </div>
      ) : (
        <div className="fail-list">
          {items.map((it) => (
            <div
              key={it.asset_id}
              className={`fail-row${sel.has(it.asset_id) ? " selected" : ""}`}
            >
              <div className="fail-head">
                <input
                  type="checkbox"
                  className="fail-check"
                  checked={sel.has(it.asset_id)}
                  onChange={() => toggle(it.asset_id)}
                  aria-label={`Select ${it.filename}`}
                />
                <strong className="fail-title">
                  #{it.asset_id} · {it.filename} ({it.media_type})
                </strong>
                <span className="pill">
                  {it.trashed ? "in trash" : "flagged"}
                </span>
                {it.file_size != null && (
                  <span className="pill">{formatBytes(it.file_size)}</span>
                )}
                <span className="spacer" />
                <span className="fail-when">
                  {(() => {
                    try {
                      return new Date(it.missing_at).toLocaleString("en-GB");
                    } catch {
                      return it.missing_at;
                    }
                  })()}
                </span>
                {it.trashed && (
                  <button
                    className="btn btn-sm"
                    onClick={() =>
                      restore([it.asset_id], `missing:restore:${it.asset_id}`)
                    }
                    disabled={anyBusy}
                    title="Restore from the trash (the file itself is still missing)"
                  >
                    {busy === `missing:restore:${it.asset_id}` ? "…" : "Restore"}
                  </button>
                )}
              </div>
              <div className="fail-path">{it.abs_path}</div>
              <div className="fail-err">
                Original not found on disk (confirmed by stat).
                {it.purge_error && (
                  <>
                    {" "}
                    <strong>Last purge refused: {it.purge_error}.</strong>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {confirmPurge && (
        <div
          className="modal-overlay"
          onClick={() => setConfirmPurge(null)}
          role="presentation"
        >
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Purge missing files"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="modal-title">
              Purge {confirmPurge.length} missing asset
              {confirmPurge.length > 1 ? "s" : ""}?
            </h2>
            <p className="hint" style={{ marginTop: 0 }}>
              The originals are already gone from disk — nothing else is
              deleted there. This removes the leftover thumbnails/proxies from
              the cache and stamps the rows as purged (kept for audit). The
              media can no longer be restored afterwards. This is irreversible.
            </p>
            <div className="dup-confirm-list">
              {confirmPurge.slice(0, 12).map((i) => (
                <div key={i.asset_id} className="dup-cmp-path">
                  {i.abs_path}
                </div>
              ))}
              {confirmPurge.length > 12 && (
                <div className="hint">…and {confirmPurge.length - 12} more.</div>
              )}
            </div>
            <div className="modal-actions">
              <button
                className="btn"
                onClick={() => setConfirmPurge(null)}
                disabled={anyBusy}
              >
                Cancel
              </button>
              <button
                className="btn btn-danger"
                onClick={() => purge(confirmPurge)}
                disabled={anyBusy}
              >
                {busy === "missing:purge"
                  ? "Working…"
                  : `Purge ${confirmPurge.length}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
