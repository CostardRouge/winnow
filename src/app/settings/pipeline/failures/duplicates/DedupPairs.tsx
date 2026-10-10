"use client";

// The deduplication backlog by FOLDER PAIR (lib/duplicatePairs). Duplicates
// arrive by whole folders — a card imported twice, a backup, a "(copy)" — so
// one decision per pair of folders replaces hundreds of identical ones in the
// group view: keep this side, delete the copies on the other.
//
// Same filter as the group view (scope tab, path search, RAW in Gallery), its
// own paging, and the same contract for the action: the request names the two
// folders and the server re-derives the groups, batch after batch, with the
// `exclude`/`retry` hand-off the plan's cards use.
//
// A side on a Final/Export volume is never offered for deletion: its button is
// simply absent and the side says why. Keeping the side WITHOUT the library
// entries relinks them; the button says so before the modal does.
import { useCallback, useEffect, useRef, useState } from "react";
import { Icons } from "../../../../ui";
import { fetchJson } from "@/lib/fetchJson";
import { splitPaths } from "@/lib/pathDiff";
import { formatBytes } from "../model";
import { ConfirmPairModal, type PairTarget } from "./DedupModals";
import { RunReportBox, type RunReport } from "./DedupPlan";
import { ZonePill } from "./DupGroupCard";
import type {
  DuplicatePair,
  DuplicatePairList,
  DuplicatePairSide,
  DuplicatePairSideKey,
  DuplicateScope,
} from "@/lib/duplicateTypes";

const PAGE = 40;

export type PairFilter = {
  scope: DuplicateScope | "all";
  q: string;
  rawInGallery: boolean;
};

export default function DedupPairs({
  filter,
  onChanged,
  onShowGroups,
}: {
  filter: PairFilter;
  /** The backlog changed: the parent refreshes its counts. */
  onChanged: () => void;
  /** Open the group view on one folder (the path search). */
  onShowGroups: (dir: string) => void;
}) {
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<DuplicatePairList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState<PairTarget | null>(null);
  const [progress, setProgress] = useState("");
  const [report, setReport] = useState<RunReport | null>(null);
  const aborted = useRef(false);
  const latest = useRef(0);

  // A new filter starts from the first page.
  const fkey = `${filter.scope}|${filter.q}|${filter.rawInGallery}`;
  useEffect(() => setOffset(0), [fkey]);

  const load = useCallback(async () => {
    const ticket = ++latest.current;
    const p = new URLSearchParams({
      scope: filter.scope,
      limit: String(PAGE),
      offset: String(offset),
    });
    if (filter.q.trim()) p.set("q", filter.q.trim());
    if (filter.rawInGallery) p.set("rawInGallery", "true");
    try {
      const d = await fetchJson<DuplicatePairList>(
        `/api/failures/duplicates/pairs?${p}`,
      );
      if (ticket !== latest.current) return;
      setData(d);
      setError(null);
    } catch (e) {
      if (ticket === latest.current) setError((e as Error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fkey, offset]);

  useEffect(() => {
    load();
  }, [load]);

  const ask = (pair: DuplicatePair, keep: DuplicatePairSideKey) => {
    const kept = pair[keep];
    const dropped = pair[keep === "left" ? "right" : "left"];
    setTarget({
      keepDir: kept.dir,
      dropDir: dropped.dir,
      groups: pair.groups,
      bytes: pair.bytes,
      relinks: dropped.library,
      reclaims: dropped.trashed,
      keepViewOnly: kept.view_only,
    });
  };

  async function runPair(t: PairTarget) {
    setBusy(true);
    const done: RunReport = {
      title: `Kept ${t.keepDir.split("/").pop()}/`,
      resolved: 0,
      deleted: 0,
      relinked: 0,
      failed: 0,
      stopped: false,
      skipped: [],
    };
    const reasons = new Map<string, number>();
    const exclude: string[] = [];
    let before = Infinity;
    aborted.current = false;
    try {
      for (let batch = 0; batch < 200 && !aborted.current; batch++) {
        const r = await fetch("/api/failures/duplicates/pairs/resolve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            keepDir: t.keepDir,
            dropDir: t.dropDir,
            scope: filter.scope,
            q: filter.q.trim() || undefined,
            rawInGallery: filter.rawInGallery || undefined,
            max: 100,
            exclude,
          }),
        });
        const d = await r.json();
        if (!r.ok) {
          reasons.set(d.error ?? "unknown error", 1);
          break;
        }
        done.resolved += d.resolved;
        done.deleted += d.deleted;
        done.relinked += d.relinked;
        done.failed += d.failed;
        exclude.push(...(d.retry ?? []));
        for (const s of d.skipped ?? [])
          reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + s.count);
        setProgress(
          `${done.resolved.toLocaleString()} group(s) done, ${d.remaining.toLocaleString()} to go…`,
        );
        if (d.remaining === 0 || d.remaining >= before) break;
        before = d.remaining;
      }
    } finally {
      done.stopped = aborted.current;
      done.skipped = [...reasons]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count);
      setProgress("");
      setTarget(null);
      setReport(done);
      setBusy(false);
      await load();
      onChanged();
    }
  }

  if (error) return <div className="empty">Could not load the folder pairs: {error}</div>;
  if (!data) return <div className="empty">Loading…</div>;

  const from = data.matched === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE, data.matched);

  return (
    <div className="dup-pairs">
      <p className="dup-summary">
        <strong>{data.matched.toLocaleString()}</strong> folder pair
        {data.matched === 1 ? "" : "s"}, biggest first.
        {data.unpaired > 0
          ? ` ${data.unpaired.toLocaleString()} group${
              data.unpaired === 1 ? " is" : "s are"
            } no pair (three or more copies, or two in one folder) and stay${
              data.unpaired === 1 ? "s" : ""
            } in the group view.`
          : ""}
      </p>
      {report && (
        <RunReportBox report={report} onDismiss={() => setReport(null)} />
      )}
      {data.pairs.length === 0 ? (
        <div className="empty" style={{ padding: 16 }}>
          No folder pair in this view.
        </div>
      ) : (
        data.pairs.map((p) => (
          <PairCard
            key={p.key}
            pair={p}
            busy={busy}
            onKeep={(side) => ask(p, side)}
            onShowGroups={onShowGroups}
          />
        ))
      )}
      {data.matched > PAGE && (
        <div className="dup-pager">
          <button
            className="btn btn-sm"
            disabled={busy || offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE))}
          >
            {Icons.back}
            <span>Previous</span>
          </button>
          <span className="hint">
            {from.toLocaleString()}–{to.toLocaleString()} of{" "}
            {data.matched.toLocaleString()}
          </span>
          <button
            className="btn btn-sm"
            disabled={busy || to >= data.matched}
            onClick={() => setOffset(offset + PAGE)}
          >
            <span>Next</span>
          </button>
        </div>
      )}
      {target && (
        <ConfirmPairModal
          target={target}
          progress={progress}
          busy={busy}
          onCancel={() => {
            if (busy) aborted.current = true;
            else setTarget(null);
          }}
          onConfirm={() => runPair(target)}
        />
      )}
    </div>
  );
}

function PairCard({
  pair,
  busy,
  onKeep,
  onShowGroups,
}: {
  pair: DuplicatePair;
  busy: boolean;
  onKeep: (side: DuplicatePairSideKey) => void;
  onShowGroups: (dir: string) => void;
}) {
  // The two folders split against each other, so the segment that differs
  // carries the eye ("x" stands in for the file name splitPaths expects).
  const [l, r] = splitPaths([`${pair.left.dir}/x`, `${pair.right.dir}/x`]);
  const sides: [DuplicatePairSideKey, DuplicatePairSide, typeof l][] = [
    ["left", pair.left, l],
    ["right", pair.right, r],
  ];
  // The suggested side's button is the card's one primary action; with no
  // suggestion, neither is.
  return (
    <article className="dup-pair">
      <div className="dup-pair-sides">
        {sides.map(([key, s, parts]) => (
          <div
            key={key}
            className={`dup-pair-side${pair.suggest === key ? " is-suggested" : ""}`}
          >
            <div className="dup-pair-tags">
              <ZonePill zone={s.zone} />
              {s.library > 0 && (
                <span className="pill dup-member-tag">
                  {s.library.toLocaleString()} in library
                </span>
              )}
              {s.trashed > 0 && (
                <span className="pill dup-member-tag">
                  {s.trashed.toLocaleString()} in trash
                </span>
              )}
              {pair.suggest === key && (
                <span className="pill dup-suggest">Suggested</span>
              )}
            </div>
            <div className="dup-cmp-path">
              <span className="dup-path-pre">{parts.prefix}</span>
              {parts.rest && (
                <span className="dup-path-diff">{parts.rest.replace(/\/$/, "")}</span>
              )}
            </div>
            {s.view_only && (
              <div className="dup-sub">view-only volume — never deleted</div>
            )}
          </div>
        ))}
      </div>
      <div className="dup-pair-meta">
        <strong>{pair.groups.toLocaleString()}</strong> identical file
        {pair.groups === 1 ? "" : "s"} on each side ·{" "}
        <strong>{formatBytes(pair.bytes)}</strong> per side
        {pair.sample.length > 0
          ? ` · ${pair.sample.join(", ")}${pair.groups > pair.sample.length ? "…" : ""}`
          : ""}
      </div>
      <div className="dup-pair-actions">
        {sides.map(([key, s]) => {
          const other = key === "left" ? pair.right : pair.left;
          // Keeping this side deletes the other one: never offered when the
          // other side is a view-only volume.
          if (other.view_only) return null;
          const relinks = other.library;
          return (
            <button
              key={key}
              className={`btn btn-sm${
                pair.suggest === key ? " btn-danger" : ""
              }`}
              disabled={busy}
              onClick={() => onKeep(key)}
              title={`Keep the copies in ${s.dir}/ and delete the ones in ${other.dir}/`}
            >
              {Icons.keep}
              <span>
                Keep {key}
                {relinks > 0 ? ` · relinks ${relinks.toLocaleString()}` : ""}
              </span>
            </button>
          );
        })}
        <button
          className="btn btn-sm"
          onClick={() => onShowGroups(pair.right.dir)}
          title="Open these groups one by one in the group view"
        >
          Review in groups
        </button>
      </div>
    </article>
  );
}
