"use client";

// The review queue: the groups no rule can decide ("Needs you" in the plan),
// one at a time, keyboard first — the way Sift culls frames. A big preview,
// the copies as numbered choices, the fate of each copy (KEEP / DELETE /
// STAYS) drawn live as the pick changes.
//
// Decisions are STAGED, not applied: nothing touches the disk until "Apply",
// so "Undo" costs nothing and needs no trash folder on the NAS. Apply then
// runs each staged pick through POST /keep — keepOneCopy, the same guards as
// the "Keep only this" button — and reports what it refused and why.
//
// Keys: 1–9 pick a copy, Enter keeps it and moves on, S skips, U undoes the
// last decision, Esc closes (asking first when decisions are staged).
import { useCallback, useEffect, useRef, useState } from "react";
import { Icons } from "../../../../ui";
import { fetchJson } from "@/lib/fetchJson";
import { splitPaths } from "@/lib/pathDiff";
import { formatBytes } from "../model";
import { RunReportBox, type RunReport } from "./DedupPlan";
import { ZonePill } from "./DupGroupCard";
import type {
  DuplicateGroup,
  DuplicateListResult,
  DuplicateScope,
  DuplicateZone,
} from "@/lib/duplicateTypes";

const PAGE = 40;

type Member = {
  path: string;
  zone: DuplicateZone;
  view_only: boolean;
  lib: "live" | "trashed" | null;
};

type Decision = { group: DuplicateGroup; keep: string | null };

// The copies of a group that still have bytes, the library entry first — the
// members keepOneCopy will see (a purged entry has none left).
function membersOf(g: DuplicateGroup): Member[] {
  const lib =
    g.existing && !g.existing.purged && g.existing.abs_path ? g.existing : null;
  const out: Member[] = [];
  if (lib)
    out.push({
      path: lib.abs_path!,
      zone: lib.zone,
      view_only: lib.view_only,
      lib: lib.deleted ? "trashed" : "live",
    });
  for (const c of g.copies)
    if (c.abs_path !== lib?.abs_path)
      out.push({ path: c.abs_path, zone: c.zone, view_only: c.view_only, lib: null });
  return out;
}

// What keeping `keep` does to `m`.
function fateOf(m: Member, keep: string | null): "keep" | "delete" | "stays" | null {
  if (keep === null) return null;
  if (m.path === keep) return "keep";
  return m.view_only ? "stays" : "delete";
}

export default function DedupReview({
  filter,
  onClose,
}: {
  filter: { scope: DuplicateScope | "all"; q: string; rawInGallery: boolean };
  /** `changed`: decisions were applied, the page reloads its counts. */
  onClose: (changed: boolean) => void;
}) {
  const [queue, setQueue] = useState<DuplicateGroup[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [idx, setIdx] = useState(0);
  const [pick, setPick] = useState<string | null>(null);
  const [staged, setStaged] = useState<Decision[]>([]);
  const [applying, setApplying] = useState("");
  const [report, setReport] = useState<RunReport | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const fetched = useRef(0);
  const inFlight = useRef(false);
  const dialog = useRef<HTMLDivElement>(null);

  // Pages of "Needs you" groups, fetched as the queue advances. Decisions are
  // staged, so the server's list does not move under us while reviewing.
  const fetchMore = useCallback(async () => {
    // One page at a time: pages arriving out of order would break the queue's
    // size order, and each request rebuilds the whole table server-side.
    if (inFlight.current) return;
    inFlight.current = true;
    const offset = fetched.current;
    fetched.current += PAGE;
    const p = new URLSearchParams({
      scope: filter.scope,
      rule: "manual",
      sort: "size",
      limit: String(PAGE),
      offset: String(offset),
    });
    if (filter.q.trim()) p.set("q", filter.q.trim());
    if (filter.rawInGallery) p.set("rawInGallery", "true");
    try {
      const d = await fetchJson<DuplicateListResult>(`/api/failures/duplicates?${p}`);
      setTotal(d.matched);
      setQueue((q) => [...q, ...d.groups]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      inFlight.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    fetchMore();
    const before = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => before?.focus?.();
  }, [fetchMore]);

  useEffect(() => {
    if (total !== null && idx >= queue.length - 5 && queue.length < total)
      fetchMore();
  }, [idx, queue.length, total, fetchMore]);

  const group = queue[idx] ?? null;
  const members = group ? membersOf(group) : [];
  // A view-only library entry can never be the loser (keepOneCopy refuses):
  // when there is one, it is the only copy that may be kept.
  const lockedTo = members.find((m) => m.lib && m.view_only)?.path ?? null;
  const pickable = (m: Member) => !lockedTo || m.path === lockedTo;

  const advance = (next: Decision[]) => {
    setStaged(next);
    setIdx(next.length);
    setPick(null);
  };
  const decide = (keep: string | null) => {
    if (!group || applying) return;
    if (keep !== null && !members.some((m) => m.path === keep && pickable(m))) return;
    advance([...staged, { group, keep }]);
  };
  const undo = () => {
    if (!staged.length || applying) return;
    const last = staged[staged.length - 1];
    setStaged(staged.slice(0, -1));
    setIdx(staged.length - 1);
    setPick(last.keep);
  };

  const keeps = staged.filter((d) => d.keep !== null);

  async function apply() {
    if (applying) return;
    setConfirmClose(false);
    const done: RunReport = {
      title: "Review",
      resolved: 0,
      deleted: 0,
      relinked: 0,
      failed: 0,
      stopped: false,
      skipped: [],
    };
    const reasons = new Map<string, number>();
    const note = (r: string) => reasons.set(r, (reasons.get(r) ?? 0) + 1);
    let n = 0;
    for (const d of keeps) {
      setApplying(`Applying ${++n} of ${keeps.length}…`);
      try {
        const r = await fetch("/api/failures/duplicates/keep", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contentHash: d.group.hash, keepPath: d.keep }),
        });
        const body = await r.json();
        if (!r.ok) {
          done.failed++;
          note(body.error ?? "unknown error");
          continue;
        }
        done.resolved++;
        done.deleted += body.deleted ?? 0;
        if (body.relinked) done.relinked++;
        for (const s of body.skipped ?? []) note(s.reason);
      } catch (e) {
        done.failed++;
        note((e as Error).message);
      }
    }
    done.skipped = [...reasons]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count);
    setApplying("");
    setReport(done);
  }

  const close = () => {
    if (applying) return;
    if (report) return onClose(true);
    if (keeps.length) return setConfirmClose(true);
    onClose(false);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.("input, textarea, select")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        e.preventDefault();
        if (confirmClose) setConfirmClose(false);
        else close();
        return;
      }
      if (report || confirmClose || applying) return;
      const k = e.key.toLowerCase();
      if (/^[1-9]$/.test(k)) {
        const m = members[Number(k) - 1];
        if (m && pickable(m)) setPick(m.path);
      } else if (k === "enter") decide(pick);
      else if (k === "s") decide(null);
      else if (k === "u") undo();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const parts = splitPaths(members.map((m) => m.path));
  const remaining = total === null ? null : Math.max(0, total - idx);
  const thumb =
    group?.existing?.has_thumb && !group.existing.purged
      ? `/api/assets/${group.existing.id}/thumb`
      : null;
  const name =
    group?.existing?.filename ?? members[0]?.path.split("/").pop() ?? "";

  return (
    <div className="modal-overlay" role="presentation">
      <div
        ref={dialog}
        tabIndex={-1}
        className="modal dup-review"
        role="dialog"
        aria-modal="true"
        aria-label="Review duplicate groups one by one"
      >
        <div className="dup-review-top">
          <h2 className="modal-title" style={{ margin: 0 }}>
            Review
          </h2>
          <span className="dup-review-prog">
            {total === null
              ? "Loading…"
              : `${Math.min(idx + 1, total).toLocaleString()} of ${total.toLocaleString()} · needs you`}
          </span>
          <span className="spacer" />
          <button
            className="btn btn-sm btn-icon"
            onClick={close}
            aria-label="Close the review"
            title="Close (Esc)"
          >
            {Icons.close}
          </button>
        </div>
        {total !== null && total > 0 && (
          <div className="dup-review-bar" aria-hidden>
            <span style={{ width: `${(Math.min(idx, total) / total) * 100}%` }} />
          </div>
        )}

        {error ? (
          <div className="empty">Could not load the groups: {error}</div>
        ) : report ? (
          <>
            <RunReportBox report={report} onDismiss={() => onClose(true)} />
            <div className="modal-actions">
              <button className="btn btn-primary" onClick={() => onClose(true)}>
                Done
              </button>
            </div>
          </>
        ) : confirmClose ? (
          <div className="dup-review-end">
            <p>
              {keeps.length.toLocaleString()} staged decision
              {keeps.length === 1 ? " has" : "s have"} not been applied. Closing
              discards {keeps.length === 1 ? "it" : "them"} — nothing on disk has
              changed.
            </p>
            <div className="modal-actions">
              <button
                className="btn"
                disabled={!!applying}
                onClick={() => setConfirmClose(false)}
              >
                Keep reviewing
              </button>
              <button
                className="btn"
                disabled={!!applying}
                onClick={() => onClose(false)}
              >
                Discard and close
              </button>
              <button className="btn btn-danger" disabled={!!applying} onClick={apply}>
                Apply {keeps.length.toLocaleString()}
              </button>
            </div>
          </div>
        ) : !group ? (
          <div className="dup-review-end">
            <p>
              {total === 0
                ? "No group needs you in this view."
                : total === null
                  ? "Loading…"
                  : "End of the queue."}
              {keeps.length > 0 &&
                ` Apply the ${keeps.length.toLocaleString()} staged decision${
                  keeps.length === 1 ? "" : "s"
                }, or press U to take the last one back.`}
            </p>
          </div>
        ) : (
          <div className="dup-review-body">
            <div className="dup-review-photo">
              {thumb ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={thumb} alt="" />
              ) : (
                <div className="dup-review-nothumb">
                  {Icons.photos}
                  <span>
                    {group.existing && !group.existing.purged
                      ? "No preview yet"
                      : "Never indexed — no preview"}
                  </span>
                </div>
              )}
              <div className="dup-review-name">
                <strong>{name}</strong>
                <span className="hint">
                  {group.file_size != null ? formatBytes(group.file_size) : ""} each
                </span>
              </div>
            </div>
            <div className="dup-review-copies">
              {members.map((m, i) => {
                const fate = fateOf(m, pick);
                const can = pickable(m);
                return (
                  <button
                    key={m.path}
                    className={`dup-choice${pick === m.path ? " is-picked" : ""}`}
                    onClick={() => can && setPick(m.path)}
                    disabled={!can}
                    title={
                      can
                        ? `Keep this copy (${i + 1})`
                        : "The library copy is on a view-only volume: it is the only copy that can be kept"
                    }
                  >
                    <span className="dup-choice-key">{i + 1}</span>
                    <span className="dup-choice-tags">
                      <ZonePill zone={m.zone} />
                      {m.lib === "live" && (
                        <span className="pill dup-member-tag">In library</span>
                      )}
                      {m.lib === "trashed" && (
                        <span className="pill dup-member-tag">In trash</span>
                      )}
                      {fate && (
                        <span className={`dup-choice-fate is-${fate}`}>{fate}</span>
                      )}
                    </span>
                    <span className="dup-cmp-path">
                      <span className="dup-path-pre">{parts[i].prefix}</span>
                      {parts[i].rest && (
                        <span className="dup-path-diff">{parts[i].rest}</span>
                      )}
                      {parts[i].fileDiffers ? (
                        <span className="dup-path-diff">{parts[i].file}</span>
                      ) : (
                        parts[i].file
                      )}
                    </span>
                  </button>
                );
              })}
              {pick && members.some((m) => m.lib === "live" && m.path !== pick) && (
                <p className="hint dup-review-note">
                  The library entry is relinked onto this copy (rating, tags and
                  previews follow)
                  {members.find((m) => m.path === pick)?.view_only
                    ? ", and will then live on a view-only volume"
                    : ""}
                  .
                </p>
              )}
              {pick && members.some((m) => m.lib === "trashed" && m.path !== pick) && (
                <p className="hint dup-review-note">
                  The entry in the trash loses its file and is marked purged.
                </p>
              )}
            </div>
          </div>
        )}

        {!report && !confirmClose && (
          <div className="dup-review-actions">
            <button
              className="btn btn-primary"
              disabled={!group || !pick || !!applying}
              onClick={() => decide(pick)}
            >
              {Icons.keep}
              <span>Keep this copy</span>
              <kbd>Enter</kbd>
            </button>
            <button className="btn" disabled={!group || !!applying} onClick={() => decide(null)}>
              <span>Skip</span>
              <kbd>S</kbd>
            </button>
            <button className="btn" disabled={!staged.length || !!applying} onClick={undo}>
              {Icons.undo}
              <span>Undo</span>
              <kbd>U</kbd>
            </button>
            <span className="spacer" />
            <span className="hint">
              {applying ||
                `${keeps.length.toLocaleString()} staged · nothing deleted yet`}
            </span>
            <button
              className="btn btn-danger"
              disabled={!keeps.length || !!applying}
              onClick={apply}
            >
              Apply {keeps.length.toLocaleString()}
            </button>
          </div>
        )}
        {remaining !== null && remaining > 0 && !report && (
          <p className="hint dup-review-keys">
            1–{Math.min(9, Math.max(members.length, 1))} pick a copy · Enter
            keep · S skip · U undo · Esc close
          </p>
        )}
      </div>
    </div>
  );
}
