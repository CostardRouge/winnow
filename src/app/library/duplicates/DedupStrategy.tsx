"use client";

// "Your own rule": a survivor strategy the user picks and applies to the whole
// current view (lib/duplicateList → strategyKeep) — the same filter as the
// list, plan card included, never a hand-built list of groups.
//
// It is the power tool beside the plan, so it is folded until opened, and it
// never acts without a preview: the server counts what the strategy would do
// over the view (groups decided, files and bytes deleted, relinks, groups
// skipped by reason) and, while it is open, every listed group marks the copy
// the strategy would keep. Apply asks once more, inline, with those numbers.
//
// A strategy skips rather than guesses (a tie, no match, two matches), and
// none moves a live library entry onto a view-only volume — that stays a
// one-group decision ("Keep only this").
import { useEffect, useRef, useState } from "react";
import { Icons } from "../../ui";
import { fetchJson } from "@/lib/fetchJson";
import { OptionPicker, type PickerOption } from "../../OptionPicker";
import { formatBytes } from "@/lib/format";
import { RunReportBox, type RunReport } from "./DedupPlan";
import type {
  DuplicatePlanKey,
  DuplicateScope,
  DuplicateStrategy,
  StrategyPreview,
} from "@/lib/duplicateTypes";

const STRATEGIES: PickerOption<DuplicateStrategy>[] = [
  {
    key: "library",
    label: "Library entry",
    hint: "Keep the live library entry where it is; nothing is relinked",
  },
  {
    key: "shortest",
    label: "Shortest path",
    hint: "Keep the copy with the shortest path; a tie skips the group",
  },
  {
    key: "folder",
    label: "Path contains…",
    hint: "Keep the one copy whose path contains your text; none or several skip the group",
  },
];

export type StrategyFilter = {
  scope: DuplicateScope | "all";
  q: string;
  rawInGallery: boolean;
  rule: DuplicatePlanKey | null;
};

export default function DedupStrategy({
  filter,
  scopeLabel,
  strategy,
  folder,
  onChange,
  onApplied,
}: {
  filter: StrategyFilter;
  scopeLabel: string;
  /** null while the panel is folded: the list then shows no strategy pick. */
  strategy: DuplicateStrategy | null;
  folder: string;
  onChange: (strategy: DuplicateStrategy | null, folder: string) => void;
  onApplied: () => void;
}) {
  const [text, setText] = useState(folder);
  const [preview, setPreview] = useState<StrategyPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [report, setReport] = useState<RunReport | null>(null);
  const aborted = useRef(false);
  const latest = useRef(0);
  // The run ends by reloading what the user looks at NOW (the filter may have
  // changed while it ran), and a filter change mid-run must not hide Stop.
  const busyRef = useRef(false);
  busyRef.current = busy;
  const onAppliedRef = useRef(onApplied);
  onAppliedRef.current = onApplied;

  // The folder text reaches the query (and the list) a beat after typing.
  useEffect(() => {
    const t = setTimeout(() => {
      if (strategy && text !== folder) onChange(strategy, text);
    }, 300);
    return () => clearTimeout(t);
  }, [text, strategy, folder, onChange]);

  const params = (() => {
    if (!strategy) return null;
    const p = new URLSearchParams({ strategy, scope: filter.scope });
    if (strategy === "folder") p.set("folder", folder);
    if (filter.q.trim()) p.set("q", filter.q.trim());
    if (filter.rawInGallery) p.set("rawInGallery", "true");
    if (filter.rule) p.set("rule", filter.rule);
    return p.toString();
  })();

  const refresh = async () => {
    if (!params) return;
    const ticket = ++latest.current;
    try {
      const d = await fetchJson<StrategyPreview>(
        `/api/failures/duplicates/strategy?${params}`,
      );
      if (ticket !== latest.current) return;
      setPreview(d);
      setError(null);
    } catch (e) {
      if (ticket === latest.current) setError((e as Error).message);
    }
  };

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (!busyRef.current) setConfirming(false);
    setPreview(null);
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  async function run() {
    if (!strategy) return;
    setBusy(true);
    const label = STRATEGIES.find((s) => s.key === strategy)?.label ?? strategy;
    const done: RunReport = {
      title: `Your rule (${label}${strategy === "folder" ? ` “${folder}”` : ""})`,
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
        const r = await fetch("/api/failures/duplicates/strategy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            strategy,
            folder: strategy === "folder" ? folder : undefined,
            scope: filter.scope,
            q: filter.q.trim() || undefined,
            rawInGallery: filter.rawInGallery || undefined,
            rule: filter.rule ?? undefined,
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
      setConfirming(false);
      setBusy(false);
      setReport(done);
      onAppliedRef.current();
      refreshRef.current();
    }
  }

  const skippedTotal = preview?.skipped.reduce((n, s) => n + s.count, 0) ?? 0;

  return (
    <details
      className="dup-strategy"
      open={strategy !== null}
      onToggle={(e) => {
        const open = (e.currentTarget as HTMLDetailsElement).open;
        if (open && !strategy) onChange("library", text);
        if (!open && strategy && !busy) onChange(null, text);
      }}
    >
      <summary>Apply a rule of your own to this view</summary>
      {strategy && (
        <div className="dup-strategy-body">
          <div className="dup-strategy-row">
            <span className="hint">Keep</span>
            <OptionPicker
              size="sm"
              ariaLabel="Which copy to keep in each group"
              options={STRATEGIES}
              value={strategy}
              onChange={(s) => onChange(s, text)}
            />
            {strategy === "folder" && (
              <input
                className="input dup-strategy-folder"
                placeholder="e.g. 2024/ or Tokyo"
                aria-label="Text the kept copy's path must contain"
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            )}
          </div>
          {error ? (
            <p className="hint">Could not preview: {error}</p>
          ) : !preview ? (
            <p className="hint">Counting…</p>
          ) : (
            <p className="dup-strategy-preview">
              In <strong>{scopeLabel}</strong>, this rule decides{" "}
              <strong>{preview.groups.toLocaleString()}</strong> group
              {preview.groups === 1 ? "" : "s"}: it deletes{" "}
              <strong>{preview.files.toLocaleString()}</strong> file
              {preview.files === 1 ? "" : "s"} (
              <strong>{formatBytes(preview.bytes)}</strong>)
              {preview.relinks > 0
                ? ` and relinks ${preview.relinks.toLocaleString()} library entr${
                    preview.relinks === 1 ? "y" : "ies"
                  } onto the copy it keeps`
                : ""}
              .{" "}
              {skippedTotal > 0 && (
                <>
                  It leaves {skippedTotal.toLocaleString()} alone:{" "}
                  {preview.skipped
                    .map((s) => `${s.count.toLocaleString()} ${s.reason}`)
                    .join(" · ")}
                  .
                </>
              )}{" "}
              The list below marks each pick.
            </p>
          )}
          <div className="dup-strategy-row">
            {!confirming ? (
              <button
                className="btn btn-sm btn-danger"
                disabled={busy || !preview?.groups}
                onClick={() => setConfirming(true)}
              >
                {Icons.keep}
                <span>
                  Apply to {(preview?.groups ?? 0).toLocaleString()} group
                  {preview?.groups === 1 ? "" : "s"}
                </span>
              </button>
            ) : (
              <>
                <span className="dup-strategy-ask">
                  Delete {(preview?.files ?? 0).toLocaleString()} file
                  {preview?.files === 1 ? "" : "s"} for good? Each copy is
                  checked against the one that stays just before it goes.
                </span>
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    if (busy) aborted.current = true;
                    else setConfirming(false);
                  }}
                >
                  {busy ? "Stop" : "Cancel"}
                </button>
                <button
                  className="btn btn-sm btn-danger"
                  disabled={busy}
                  onClick={run}
                >
                  {busy
                    ? progress || "Working…"
                    : `Delete ${(preview?.files ?? 0).toLocaleString()} file${
                        preview?.files === 1 ? "" : "s"
                      }`}
                </button>
              </>
            )}
          </div>
          {report && (
            <RunReportBox report={report} onDismiss={() => setReport(null)} />
          )}
        </div>
      )}
    </details>
  );
}
