"use client";

// Failures › Deduplication: the duplicate-triage surface, on its own URL so a
// review session ("here, sort these out") can be linked to directly.
//
// The list this page draws is the biggest in the app — a real library carries
// thousands of recorded duplicate hits — so it is built around finding the ones
// worth acting on rather than scrolling them all:
//
//   • a scope picker splitting the backlog the way the workflow does — copies
//     still in Incoming, copies that reached the finalized Gallery, and the
//     ones sitting in BOTH (the interesting case: the same bytes on each side),
//   • biggest-win-first ordering and a running "to reclaim" figure, so the
//     first page is the most disk a click can free,
//   • server-side paging, so the page renders forty groups and not five
//     thousand,
//   • the survivor the bulk rule would keep, drawn on every group with the
//     reason it was picked, so "Keep suggested" can be checked group by group
//     before it is trusted over the whole filter,
//   • a cleanup plan — one card per branch of the bulk rule, plus "Needs you"
//     — each with its rule, its numbers and its own bulk "Keep suggested",
//     because clicking through those groups one at a time is data entry, not
//     triage; a run reports why it left any group behind,
//   • a standing report of the RAW masters found in the Gallery: the workflow
//     says a RAW belongs in Incoming and an export in the Gallery, and those
//     volumes are view-only, so this page can only name them — not fix them.
//
// Every destructive action still goes through the same lib/duplicates guards it
// always did; nothing here reaches around them.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icons } from "../../../../ui";
import { FamilyShell } from "../sections";
import { formatBytes } from "../model";
import DupGroupCard, { FalseCollisionRow } from "./DupGroupCard";
import DedupPlan, { PLAN_CARDS, type RunReport } from "./DedupPlan";
import DedupPairs from "./DedupPairs";
import DedupReview from "./DedupReview";
import DedupStrategy from "./DedupStrategy";
import { OptionPicker, type PickerOption } from "../../../../OptionPicker";
import {
  ConfirmAutoModal,
  ConfirmDeleteModal,
  ConfirmDiscardModal,
  ConfirmKeepModal,
  type AutoTarget,
  type KeepTarget,
} from "./DedupModals";
import {
  EMPTY_QUERY,
  PAGE_SIZE,
  useDuplicates,
  type DuplicateQuery,
} from "./useDuplicates";
import type {
  DuplicateAutoRule,
  DuplicateExisting,
  DuplicateGroup,
  DuplicateScope,
  DuplicateSort,
} from "@/lib/duplicateTypes";

// The scope picker. Same `.tabs`/`.tab` segmented control as the Incoming /
// Gallery / All toggle on /gear, /people and /search — but NOT that component
// (LibrarySourceTabs): a duplicate group is a set of copies, so it has two
// values that toggle has no meaning for ("mixed" = the same bytes on both
// sides, "elsewhere" = Export volumes and unregistered folders), and every tab
// carries its own group count.
const SCOPES: { key: DuplicateScope | "all"; label: string; title: string }[] = [
  { key: "all", label: "All", title: "Every recorded duplicate group" },
  {
    key: "incoming",
    label: "Incoming",
    title: "Every copy is still in the cullable tree",
  },
  {
    key: "gallery",
    label: "Gallery",
    title: "Every copy is a finalized master (view-only — nothing to delete)",
  },
  {
    key: "mixed",
    label: "Both sides",
    title: "The same bytes exist in Incoming AND in the Gallery",
  },
  {
    key: "elsewhere",
    label: "Elsewhere",
    title: "Export volumes and folders registered as no root at all",
  },
];

const SORTS: { key: DuplicateSort; label: string }[] = [
  { key: "size", label: "Most to reclaim" },
  { key: "recent", label: "Most recent" },
  { key: "path", label: "Path" },
];

const SCOPE_KEY = "winnow.dedup.scope";

// Two readings of the same filtered backlog: one card per group of identical
// copies, or one per pair of folders those copies live in.
type DedupView = "groups" | "pairs";
const VIEWS: PickerOption<DedupView>[] = [
  {
    key: "groups",
    label: "Groups",
    hint: "One card per set of identical copies, with the plan above",
  },
  {
    key: "pairs",
    label: "Folder pairs",
    hint: "One card per pair of folders holding the same files — keep one side",
  },
];
const VIEW_KEY = "winnow.dedup.view";

export default function DuplicatesFailuresPage() {
  const [query, setQuery] = useState<DuplicateQuery>(EMPTY_QUERY);
  // Typing must not fire a request per keystroke: the field is local, the query
  // follows a beat later (and rewinds to the first page, or the user lands on
  // page 7 of a three-page result).
  const [search, setSearch] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  // The bulk collapse runs batch after batch and can take minutes on a real
  // backlog; "Stop" flips this and the loop ends after the batch in flight,
  // leaving everything it already did in place.
  const aborted = useRef(false);
  // Pending confirmations: on-disk paths to delete, a keep-one pick, a trashed
  // library copy to drop on its own, or the bulk collapse.
  const [confirm, setConfirm] = useState<string[] | null>(null);
  const [keep, setKeep] = useState<KeepTarget | null>(null);
  const [discard, setDiscard] = useState<DuplicateExisting | null>(null);
  const [auto, setAuto] = useState<AutoTarget | null>(null);
  const [report, setReport] = useState<RunReport | null>(null);

  const { data, error, loading, load } = useDuplicates(query);
  const [view, setView] = useState<DedupView>("groups");
  const [reviewing, setReviewing] = useState(false);

  // Restore the chosen scope between visits, seeded once on mount so a later
  // write never yanks the tab out from under whatever the user just clicked —
  // same contract as useStoredLibrarySource.
  useEffect(() => {
    const saved = localStorage.getItem(SCOPE_KEY);
    if (saved && SCOPES.some((s) => s.key === saved))
      setQuery((qq) => ({ ...qq, scope: saved as DuplicateScope | "all" }));
    const savedView = localStorage.getItem(VIEW_KEY);
    if (savedView === "pairs" || savedView === "groups") setView(savedView);
  }, []);
  const pickView = (v: DedupView) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {}
  };

  useEffect(() => {
    const t = setTimeout(
      () => setQuery((qq) => (qq.q === search ? qq : { ...qq, q: search, offset: 0 })),
      250,
    );
    return () => clearTimeout(t);
  }, [search]);

  const patch = (p: Partial<DuplicateQuery>) =>
    setQuery((qq) => ({ ...qq, offset: 0, ...p }));
  // Stable: the strategy panel debounces its folder field against it.
  const setStrategy = useCallback(
    (strategy: DuplicateQuery["strategy"], folder: string) =>
      setQuery((qq) => ({ ...qq, offset: 0, strategy, folder })),
    [],
  );

  const groups = useMemo(() => data?.groups ?? [], [data]);

  // Keep the selection in sync with the copies still on screen: rows vanish
  // after a delete, and paging away must not carry a hidden pending deletion to
  // the next page's "Delete selected".
  const sig = groups.map((g) => g.hash).join(" ");
  useEffect(() => {
    const live = new Set(groups.flatMap((g) => g.copies.map((c) => c.abs_path)));
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
  const selectable = groups.flatMap((g) =>
    g.copies.filter((c) => !c.view_only).map((c) => c.abs_path),
  );
  const allChecked = selectable.length > 0 && selectable.every((p) => sel.has(p));
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
  const askKeep = (g: DuplicateGroup, keepPath: string, keepLabel: string) => {
    const lib = g.existing;
    const libLoser = !!(lib?.abs_path && keepPath !== lib.abs_path);
    const members = [
      ...(lib?.abs_path && !lib.purged && !lib.view_only ? [lib.abs_path] : []),
      ...g.copies.filter((c) => !c.view_only).map((c) => c.abs_path),
    ];
    setKeep({
      hash: g.hash,
      keepPath,
      keepLabel,
      deletions: members.filter((p) => p !== keepPath),
      relink: libLoser && !lib!.deleted,
      reclaim: libLoser && !!lib!.deleted,
    });
  };

  async function post(url: string, body?: unknown) {
    const r = await fetch(url, {
      method: "POST",
      ...(body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
    return { ok: r.ok, data: await r.json() };
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setMsg("");
    try {
      await fn();
      await load();
    } finally {
      setBusy(false);
    }
  }

  // What a single action left in place, with each copy's reason — a count
  // alone does not tell the user whether to rescan, fix a permission or move a
  // file by hand (CODEBASE-AUDIT UX-05).
  const leftInPlace = (skipped: { path: string; reason: string }[] = []) =>
    skipped.length
      ? ` Left in place: ${skipped
          .map((s) => `${s.path.split("/").pop()} (${s.reason})`)
          .join("; ")}.`
      : "";

  const runDelete = (paths: string[]) =>
    run(async () => {
      const { ok, data: d } = await post("/api/failures/duplicates/delete", {
        paths,
      });
      setMsg(
        ok
          ? `Deleted ${d.deleted ?? 0} duplicate file(s).${leftInPlace(d.skipped)}`
          : `Error: ${d.error ?? "unknown"}`,
      );
      setSel(new Set());
      setConfirm(null);
    });

  const runKeep = (t: KeepTarget) =>
    run(async () => {
      const { ok, data: d } = await post("/api/failures/duplicates/keep", {
        contentHash: t.hash,
        keepPath: t.keepPath,
      });
      setMsg(
        ok
          ? `Kept 1 copy; deleted ${d.deleted ?? 0} file(s).${
              d.relinked ? " Library entry relinked to the copy you kept." : ""
            }${
              d.purged
                ? " The library entry was in the trash: its bytes are reclaimed and it stays there."
                : ""
            }${leftInPlace(d.skipped)}`
          : `Error: ${d.error ?? "unknown"}`,
      );
      setKeep(null);
    });

  // Drop just the trashed library copy of a group, leaving the other extras
  // listed. Only offered for a copy already in the trash — a live one has to go
  // through "Keep only this", which relinks the entry instead of orphaning it.
  const runDiscard = (existing: DuplicateExisting) =>
    run(async () => {
      const { ok, data: d } = await post("/api/failures/duplicates/discard", {
        assetId: existing.id,
      });
      setMsg(
        ok
          ? `Removed the trashed library copy #${existing.id}${
              d.deleted ? "" : " (its bytes were already gone)"
            }. It stays in the trash, marked purged.`
          : `Error: ${d.error ?? "unknown"}`,
      );
      setDiscard(null);
    });

  // Clear the rows that no longer describe a real duplication — a file removed
  // by hand outside this page, a hash still held by an already-purged library
  // entry, a lone copy nothing shadows any more. Nothing on disk is touched.
  const runSweep = () =>
    run(async () => {
      const { ok, data: d } = await post(
        "/api/failures/duplicates/purge-resolved",
      );
      if (!ok) {
        setMsg(`Error: ${d.error ?? "unknown"}`);
        return;
      }
      const cleared = (d.purged ?? 0) + (d.stale ?? 0);
      setMsg(
        cleared === 0 && !d.released
          ? `Nothing to clear — every recorded entry still describes a real duplication (checked ${d.checked}).`
          : `Cleared ${cleared} stale entr${cleared === 1 ? "y" : "ies"}: ${
              d.purged
            } whose file was already gone from disk, ${
              d.stale
            } with nothing left to compare against${
              d.released
                ? `. Released ${d.released} content hash(es) held by purged entries, so those files can be indexed again`
                : ""
            }. Checked ${d.checked}.`,
      );
    });

  // Keep the suggested copy in every group of one plan card, within the
  // current filter, batch after batch. The server derives every survivor from
  // the filter; what the client sends back is only `exclude` — the groups this
  // run already tried and left behind (`retry`), which can only narrow it and
  // keep the next batch from re-picking the same refusals at the head of the
  // size order. The loop still stops on lack of PROGRESS, never on emptiness.
  const runAuto = (rule: DuplicateAutoRule) =>
    run(async () => {
      const done: RunReport = {
        title: PLAN_CARDS.find((c) => c.key === rule)?.title ?? rule,
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
      for (let batch = 0; batch < 200 && !aborted.current; batch++) {
        const { ok, data: d } = await post("/api/failures/duplicates/resolve", {
          scope: query.scope,
          q: query.q.trim() || undefined,
          rawInGallery: query.rawInGallery || undefined,
          rule,
          max: 100,
          exclude,
        });
        if (!ok) {
          setMsg(`Error: ${d.error ?? "unknown"}`);
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
      done.stopped = aborted.current;
      done.skipped = [...reasons]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count);
      setProgress("");
      setAuto(null);
      setReport(done);
    });

  const facets = data?.facets;
  const matched = data?.matched ?? 0;
  const scopeLabel =
    SCOPES.find((s) => s.key === query.scope)?.label ?? "this view";
  const from = matched === 0 ? 0 : query.offset + 1;
  const to = Math.min(query.offset + PAGE_SIZE, matched);
  const activeFacet = facets?.[query.scope] ?? null;
  const ruleLabel = query.rule
    ? PLAN_CARDS.find((c) => c.key === query.rule)?.title
    : null;

  return (
    <FamilyShell onRefresh={load} error={error} msg={msg}>
      <section style={{ marginBottom: 28 }}>
        <div className="filterbar" style={{ marginBottom: 6 }}>
          {view === "groups" && selectable.length > 0 && (
            <input
              ref={headRef}
              type="checkbox"
              className="fail-check"
              aria-label="Select every on-disk copy on this page"
              checked={allChecked}
              onChange={(e) =>
                setSel(e.target.checked ? new Set(selectable) : new Set())
              }
            />
          )}
          <h3 style={{ margin: 0 }}>
            Deduplication{" "}
            <span className="hint">({(data?.total ?? 0).toLocaleString()})</span>
          </h3>
          <span className="spacer" />
          <button
            className="btn"
            disabled={busy || !data?.total}
            onClick={runSweep}
            title="Drop the entries that no longer describe a duplication: file already gone, or nothing left holding the same content"
          >
            {Icons.reset}
            <span>Clear resolved</span>
          </button>
          {view === "groups" && (
            <button
              className="btn btn-danger"
              disabled={busy || sel.size === 0}
              onClick={() => setConfirm([...sel])}
            >
              {Icons.trash}
              <span>Delete selected ({sel.size})</span>
            </button>
          )}
        </div>

        <div className="tabs dup-scopes" role="group" aria-label="Which side of the library">
          {SCOPES.map((s) => (
            <button
              key={s.key}
              className={`tab${query.scope === s.key ? " active" : ""}`}
              onClick={() => {
                patch({ scope: s.key });
                localStorage.setItem(SCOPE_KEY, s.key);
              }}
              aria-pressed={query.scope === s.key}
              title={s.title}
            >
              {s.label}
              <span className="tab-count">
                {(facets?.[s.key]?.groups ?? 0).toLocaleString()}
              </span>
            </button>
          ))}
        </div>

        <div className="filterbar dup-toolbar">
          <OptionPicker
            size="sm"
            ariaLabel="How to read the backlog"
            options={VIEWS}
            value={view}
            onChange={pickView}
          />
          <input
            className="input"
            style={{ maxWidth: 260 }}
            placeholder="Filter by path (e.g. 2024, trash)…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <label className="dup-check-label" title="Only the groups holding a RAW file that sits in the Gallery">
            <input
              type="checkbox"
              className="fail-check"
              checked={query.rawInGallery}
              onChange={(e) => patch({ rawInGallery: e.target.checked })}
            />
            <span>RAW in Gallery only</span>
          </label>
          <span className="spacer" />
          {/* Pairs always come biggest first: the sort is the group view's. */}
          {view === "groups" && (
            <label className="dup-sort">
              <span className="hint">Sort</span>
              <select
                className="input"
                value={query.sort}
                onChange={(e) => patch({ sort: e.target.value as DuplicateSort })}
              >
                {SORTS.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        {view === "groups" && activeFacet && (
          <p className="dup-summary">
            <strong>{matched.toLocaleString()}</strong> group
            {matched === 1 ? "" : "s"} in {scopeLabel}
            {ruleLabel ? ` · ${ruleLabel}` : ""} ·{" "}
            <strong>{Math.round(activeFacet.extras).toLocaleString()}</strong>{" "}
            extra cop{activeFacet.extras === 1 ? "y" : "ies"} ·{" "}
            <strong>{formatBytes(activeFacet.reclaimable)}</strong> to reclaim
            {data && data.stale > 0
              ? ` · ${data.stale.toLocaleString()} already resolved (use “Clear resolved”)`
              : ""}
          </p>
        )}

        {view === "groups" && data && (
          <DedupPlan
            plan={data.plan}
            active={query.rule}
            busy={busy}
            report={report}
            onShow={(rule) => patch({ rule })}
            onRun={(rule) =>
              setAuto({
                rule,
                groups: data.plan[rule].groups,
                reclaimable: data.plan[rule].reclaimable,
                scopeLabel,
              })
            }
            onReview={() => setReviewing(true)}
            onDismissReport={() => setReport(null)}
          />
        )}

        {view === "groups" && data && (
          <DedupStrategy
            filter={{
              scope: query.scope,
              q: query.q,
              rawInGallery: query.rawInGallery,
              rule: query.rule,
            }}
            scopeLabel={
              ruleLabel ? `${scopeLabel} · ${ruleLabel}` : scopeLabel
            }
            strategy={query.strategy}
            folder={query.folder}
            onChange={setStrategy}
            onApplied={load}
          />
        )}

        {/* The workflow's standing rule, reported over the WHOLE table rather
            than the current filter: a RAW has no place in the finished Gallery.
            Those volumes are view-only, so the fix is to move the file — this
            page can only point at it. */}
        {data && data.rawInGallery.groups > 0 && (
          <div className="dup-report">
            <p>
              <strong>{data.rawInGallery.groups.toLocaleString()}</strong> RAW
              master{data.rawInGallery.groups === 1 ? "" : "s"} duplicated into
              the Gallery ({formatBytes(data.rawInGallery.bytes)}). A RAW belongs
              in Incoming and its export in the Gallery — but Final/Export
              volumes are view-only, so these have to be moved by hand.
            </p>
            {!query.rawInGallery && (
              <button
                className="btn btn-sm"
                onClick={() => patch({ rawInGallery: true, scope: "all" })}
              >
                Show them
              </button>
            )}
          </div>
        )}

        {/* The rules govern every action below, so they stay one click away
            instead of a paragraph to re-read above the list. */}
        <details className="dup-rules">
          <summary>How deduplication decides</summary>
          <p>
            Files matched as duplicates by partial hash, grouped by content. Each
            group holds the same bytes in more than one place — the library’s copy
            and any extra copies on disk. Where a rule can tell which copy to
            keep — the one on a Final/Export volume, or else the live library
            entry — that copy is marked <strong>suggested</strong> and{" "}
            <strong>“Keep suggested”</strong> keeps it. Otherwise Winnow doesn’t
            assume which is the original: pick the one to keep with{" "}
            <strong>“Keep only this”</strong> and the rest are removed (the
            library entry is relinked onto your pick if it’s an on-disk copy),
            leaving a single media. A library copy
            already in the trash is never relinked: its file is removed and the
            entry marked purged — and it can be dropped on its own with its row’s
            delete. Copies on a{" "}
            <strong>Final or Export volume are never deleted</strong>: those
            masters are view-only, so they’re shown locked and are the copy the
            group collapses onto. False collisions — genuinely distinct content
            that merely shares a partial hash — are indexed separately and never
            collapsed; they’re listed below for audit only.
            {data && data.falseCollisions > 0
              ? ` ${data.falseCollisions} false collision(s) recovered.`
              : ""}
          </p>
        </details>

        {view === "pairs" ? (
          <DedupPairs
            filter={{
              scope: query.scope,
              q: query.q,
              rawInGallery: query.rawInGallery,
            }}
            onChanged={load}
            onShowGroups={(dir) => {
              setSearch(dir);
              pickView("groups");
            }}
          />
        ) : loading && !data ? (
          <div className="empty" style={{ padding: 16 }}>
            Loading…
          </div>
        ) : !data?.total ? (
          <div className="empty" style={{ padding: 16 }}>
            Nothing here. 🎉
          </div>
        ) : groups.length === 0 && data.falseItems.length === 0 ? (
          <div className="empty" style={{ padding: 16 }}>
            No duplicate group matches this filter.
          </div>
        ) : (
          <div className="dup-groups">
            {groups.map((g) => (
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
            {matched > PAGE_SIZE && (
              <div className="dup-pager">
                <button
                  className="btn btn-sm"
                  disabled={busy || query.offset === 0}
                  onClick={() =>
                    setQuery((qq) => ({
                      ...qq,
                      offset: Math.max(0, qq.offset - PAGE_SIZE),
                    }))
                  }
                >
                  {Icons.back}
                  <span>Previous</span>
                </button>
                <span className="hint">
                  {from.toLocaleString()}–{to.toLocaleString()} of{" "}
                  {matched.toLocaleString()}
                </span>
                <button
                  className="btn btn-sm"
                  disabled={busy || to >= matched}
                  onClick={() =>
                    setQuery((qq) => ({ ...qq, offset: qq.offset + PAGE_SIZE }))
                  }
                >
                  <span>Next</span>
                </button>
              </div>
            )}
            {/* Audit only, and only on the first page — they are not part of the
                group paging (nothing can be done to them). */}
            {query.offset === 0 && data.falseItems.length > 0 && (
              <div className="dup-false">
                <div className="dup-false-head">
                  Distinct content (false collisions) — kept, audit only
                </div>
                {data.falseItems.map((it) => (
                  <FalseCollisionRow key={it.abs_path} it={it} />
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      {reviewing && (
        <DedupReview
          filter={{
            scope: query.scope,
            q: query.q,
            rawInGallery: query.rawInGallery,
          }}
          onClose={(changed) => {
            setReviewing(false);
            if (changed) load();
          }}
        />
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
      {auto && (
        <ConfirmAutoModal
          target={auto}
          progress={progress}
          busy={busy}
          onCancel={() => {
            if (busy) aborted.current = true;
            else setAuto(null);
          }}
          onConfirm={() => runAuto(auto.rule)}
        />
      )}
    </FamilyShell>
  );
}
