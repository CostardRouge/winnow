"use client";

// Centralized list of what has failed (scan / analyze / import), with the
// error message for debugging. Lives under /pipeline (the section chrome — heading
// + tabs — is provided by the layout). Retry is available three ways:
//   - per item   : the "Retry" button on each row,
//   - selected   : the checked rows ("Retry selected"),
//   - everything : the whole family ("Retry all").
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchJson } from "@/lib/fetchJson";
import { Icons, LazyImage } from "../../ui";
import PullToRefresh from "../../PullToRefresh";
import MediaViewer from "../../MediaViewer";

type DerivItem = {
  asset_id: number;
  filename: string;
  abs_path: string;
  media_type: string;
  error: string | null;
  updated_at: string;
};
type ScanItem = {
  abs_path: string;
  error: string;
  attempts: number;
  updated_at: string;
};
type ImportItem = {
  batch_id: number;
  origin: string | null;
  file: string;
  error: string;
  created_at: string;
};
// The kept, indexed copy a duplicate matched — its thumbnail stands in for the
// (identical) duplicate, and its path/name let the user compare the two.
type ExistingAsset = {
  id: number;
  filename: string | null;
  abs_path: string | null;
  media_type: string | null;
  has_thumb: boolean;
  deleted: boolean;
};
type DuplicateItem = {
  abs_path: string;
  content_hash: string;
  existing_asset_id: number | null;
  source: string;
  verified: boolean | null;
  hits: number;
  file_size: number | null;
  updated_at: string;
  existing: ExistingAsset | null;
};
// An indexed asset whose ORIGINAL is gone from disk (cf. lib/integrity.ts).
// `trashed` = auto-trashed by the detector (reversible); false = only flagged
// (mass-disappearance guard) and still visible in the library.
type MissingItem = {
  asset_id: number;
  filename: string;
  abs_path: string;
  media_type: string;
  file_size: number | null;
  missing_at: string;
  trashed: boolean;
};
type Failures = {
  derivative: { count: number; items: DerivItem[] };
  scan: { count: number; items: ScanItem[] };
  import: { count: number; items: ImportItem[] };
  duplicates: {
    count: number;
    falseCollisions: number;
    items: DuplicateItem[];
  };
  missing: { count: number; items: MissingItem[] };
};

type Kind = "derivative" | "scan" | "import" | "missing";
type Scope = { ids?: number[]; paths?: string[] };

// The failure families, one per tab. "derivative" doubles as the default tab.
type Family = "derivative" | "scan" | "import" | "duplicates" | "missing";
const FAMILY_ORDER: Family[] = [
  "derivative",
  "scan",
  "import",
  "duplicates",
  "missing",
];
const FAMILY_LABELS: Record<Family, string> = {
  derivative: "Analyze",
  scan: "Scan",
  import: "Import",
  duplicates: "Deduplication",
  missing: "Missing files",
};

type RowData<K extends string | number> = {
  key: K;
  title: string;
  path?: string;
  error: string;
  when: string;
  badge?: string;
  // When the failure maps to an indexed asset, a link to download its original
  // file (so an item that can't be previewed can still be inspected locally).
  downloadHref?: string;
};

export default function FailuresPage() {
  const [data, setData] = useState<Failures | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Key of the in-flight retry (e.g. "scan:all", "derivative:one:42"), so a
  // single button spins while the rest are disabled to prevent double-submits.
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string>("");
  // Which failure family is shown. Null until the first load lands, so the
  // initial tab can default to the first family that actually has failures
  // (without overriding a tab the user has since picked, nor resetting on polls).
  const [tab, setTab] = useState<Family | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await fetchJson<Failures>("/api/failures"));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const doRetry = useCallback(
    async (kind: Kind, scope: Scope, busyKey: string) => {
      if (busy) return;
      setBusy(busyKey);
      setMsg("");
      try {
        const r = await fetch("/api/failures/retry", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind, ...scope }),
        });
        const d = await r.json();
        setMsg(
          r.ok
            ? `Re-queued ${kind} (${d.retried ?? 0}). Watch the counts drop as it reprocesses.`
            : `Error: ${d.error ?? "unknown"}`,
        );
        await load();
      } finally {
        setBusy(null);
      }
    },
    [busy, load],
  );

  // null = retry everything in the family; otherwise the picked keys.
  const onRetryDeriv = (keys: number[] | null, busyKey: string) =>
    doRetry("derivative", keys ? { ids: keys } : {}, busyKey);
  const onRetryScan = (keys: string[] | null, busyKey: string) =>
    doRetry("scan", keys ? { paths: keys } : {}, busyKey);

  const derivRows: RowData<number>[] = (data?.derivative.items ?? []).map(
    (it) => ({
      key: it.asset_id,
      title: `#${it.asset_id} · ${it.filename} (${it.media_type})`,
      path: it.abs_path,
      error: it.error ?? "—",
      when: it.updated_at,
      downloadHref: `/api/assets/${it.asset_id}/download`,
    }),
  );
  const scanRows: RowData<string>[] = (data?.scan.items ?? []).map((it) => ({
    key: it.abs_path,
    title: it.abs_path,
    error: it.error,
    when: it.updated_at,
    badge: `${it.attempts}×`,
  }));

  const counts: Record<Family, number> = {
    derivative: data?.derivative.count ?? 0,
    scan: data?.scan.count ?? 0,
    import: data?.import.count ?? 0,
    duplicates: data?.duplicates.count ?? 0,
    missing: data?.missing?.count ?? 0,
  };

  // On the first successful load, land on the first family that actually has
  // failures (falling back to Analyze). Runs only while no tab is chosen, so it
  // neither fights the user's clicks nor re-picks on every 5 s poll.
  useEffect(() => {
    if (tab !== null || !data) return;
    setTab(FAMILY_ORDER.find((k) => counts[k] > 0) ?? "derivative");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, tab]);
  const activeTab: Family = tab ?? "derivative";

  return (
    <PullToRefresh className="pl-section" onRefresh={load}>
      <div className="filterbar">
        <span className="hint">
          Everything that failed (scan · analyze · import · deduplication), in
          one place. Pick a family below, fix the cause, then retry per item, by
          selection, or by family.
        </span>
        <span className="spacer" />
        <button className="btn btn-sm" onClick={load}>
          Refresh
        </button>
      </div>

      <nav className="fail-tabs" aria-label="Failure families">
        {FAMILY_ORDER.map((k) => {
          const isActive = activeTab === k;
          return (
            <button
              key={k}
              type="button"
              className={`fail-tab${isActive ? " active" : ""}${
                counts[k] > 0 ? " bad" : ""
              }`}
              aria-current={isActive ? "true" : undefined}
              onClick={() => setTab(k)}
            >
              <span>{FAMILY_LABELS[k]}</span>
              <span className="fail-tab-count">
                {counts[k].toLocaleString()}
              </span>
            </button>
          );
        })}
      </nav>

      {error && (
        <div className="error-box">
          <span>Couldn’t load failures: {error}</span>
          <button className="btn" onClick={load}>
            Retry
          </button>
        </div>
      )}
      {msg && <p className="hint">{msg}</p>}

      {activeTab === "derivative" && (
        <RetrySection<number>
          title="Analyze (derivatives)"
          hint="Photo/video derivative generation failed — check the message, fix the cause (e.g. ffmpeg/codec), then retry."
          count={counts.derivative}
          rows={derivRows}
          retryAllLabel="Retry all"
          prefix="derivative"
          busy={busy}
          onRetry={onRetryDeriv}
        />
      )}

      {activeTab === "scan" && (
        <RetrySection<string>
          title="Scan (indexing)"
          hint="Files that couldn’t be indexed (unreadable, corrupt, metadata error). Retry re-scans the affected roots."
          count={counts.scan}
          rows={scanRows}
          retryAllLabel="Retry all"
          prefix="scan"
          busy={busy}
          onRetry={onRetryScan}
        />
      )}

      {activeTab === "import" && (
        <Section
          title="Import"
          hint="Files that failed verification/filing. Failed files are quarantined in the inbox’s .failed/ folder; retry re-imports them (whole quarantine)."
          count={counts.import}
          onRetry={() => doRetry("import", {}, "import:all")}
          busy={busy === "import:all"}
          disabled={busy !== null}
          retryLabel="Retry quarantine"
        >
          {(data?.import.items ?? []).map((it, i) => (
            <FailRow
              key={`i${it.batch_id}-${i}`}
              title={it.file}
              error={it.error}
              when={it.created_at}
              badge={it.origin ?? undefined}
            />
          ))}
        </Section>
      )}

      {activeTab === "duplicates" && (
        <DedupSection
          count={counts.duplicates}
          falseCollisions={data?.duplicates.falseCollisions ?? 0}
          items={data?.duplicates.items ?? []}
          onChanged={load}
          setMsg={setMsg}
        />
      )}

      {activeTab === "missing" && (
        <MissingSection
          count={counts.missing}
          items={data?.missing?.items ?? []}
          onChanged={load}
          setMsg={setMsg}
        />
      )}
    </PullToRefresh>
  );
}

// Bytes → short human size (1 decimal). Mirrors the compact figures elsewhere.
function formatBytes(n: number | null | undefined): string {
  if (n == null) return "";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${u[i]}`;
}

// A failure family with selectable rows: per-row retry, "Retry selected"
// (checked rows) and "Retry all" (the whole family, server-side — even rows
// beyond the listing cap).
function RetrySection<K extends string | number>({
  title,
  hint,
  count,
  rows,
  retryAllLabel,
  prefix,
  busy,
  onRetry,
}: {
  title: string;
  hint: React.ReactNode;
  count: number;
  rows: RowData<K>[];
  retryAllLabel: string;
  prefix: string;
  busy: string | null;
  onRetry: (keys: K[] | null, busyKey: string) => void;
}) {
  const [sel, setSel] = useState<Set<K>>(new Set());
  const anyBusy = busy !== null;
  const allKey = `${prefix}:all`;
  const selKey = `${prefix}:selected`;

  // Prune the selection when the rows change (e.g. items resolved after a
  // retry) so vanished items never stay checked. Keyed on the row signature so
  // the effect doesn't loop on every render.
  const sig = rows.map((r) => r.key).join(" ");
  useEffect(() => {
    setSel((prev) => {
      const valid = new Set(rows.map((r) => r.key));
      const next = new Set<K>();
      for (const k of prev) if (valid.has(k)) next.add(k);
      return next.size === prev.size ? prev : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  const allChecked = rows.length > 0 && sel.size === rows.length;
  const someChecked = sel.size > 0 && !allChecked;
  const headRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (headRef.current) headRef.current.indeterminate = someChecked;
  }, [someChecked]);

  const toggle = (k: K) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  const retrySelected = () => {
    const keys = [...sel];
    if (!keys.length) return;
    setSel(new Set());
    onRetry(keys, selKey);
  };

  return (
    <section style={{ marginBottom: 28 }}>
      <div className="filterbar" style={{ marginBottom: 6 }}>
        {count > 0 && (
          <input
            ref={headRef}
            type="checkbox"
            className="fail-check"
            aria-label={`Select all — ${title}`}
            checked={allChecked}
            onChange={(e) =>
              setSel(
                e.target.checked ? new Set(rows.map((r) => r.key)) : new Set(),
              )
            }
          />
        )}
        <h3 style={{ margin: 0 }}>
          {title} <span className="hint">({count})</span>
        </h3>
        <span className="spacer" />
        <button
          className="btn"
          onClick={retrySelected}
          disabled={anyBusy || sel.size === 0}
        >
          {busy === selKey ? "…" : `Retry selected (${sel.size})`}
        </button>
        <button
          className="btn"
          onClick={() => onRetry(null, allKey)}
          disabled={anyBusy || count === 0}
        >
          {busy === allKey ? "…" : retryAllLabel}
        </button>
      </div>
      <p className="hint" style={{ marginTop: 0 }}>
        {hint}
      </p>
      {count === 0 ? (
        <div className="empty" style={{ padding: 16 }}>
          Nothing here. 🎉
        </div>
      ) : (
        <div className="fail-list">
          {rows.map(({ key, ...row }) => {
            const oneKey = `${prefix}:one:${key}`;
            return (
              <FailRow
                key={String(key)}
                {...row}
                selected={sel.has(key)}
                onToggle={() => toggle(key)}
                onRetry={() => onRetry([key], oneKey)}
                retrying={busy === oneKey}
                disabled={anyBusy}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

// A failure family with no per-row retry: a single family-wide action (or none,
// for the audit-only deduplication list).
function Section({
  title,
  hint,
  count,
  onRetry,
  busy,
  disabled,
  retryLabel,
  children,
}: {
  title: string;
  hint: React.ReactNode;
  count: number;
  onRetry?: () => void;
  busy?: boolean;
  disabled?: boolean;
  retryLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <section style={{ marginBottom: 28 }}>
      <div className="filterbar" style={{ marginBottom: 6 }}>
        <h3 style={{ margin: 0 }}>
          {title} <span className="hint">({count})</span>
        </h3>
        <span className="spacer" />
        {onRetry && (
          <button
            className="btn"
            onClick={onRetry}
            disabled={busy || disabled || count === 0}
          >
            {busy ? "…" : retryLabel}
          </button>
        )}
      </div>
      <p className="hint" style={{ marginTop: 0 }}>
        {hint}
      </p>
      {count === 0 ? (
        <div className="empty" style={{ padding: 16 }}>
          Nothing here. 🎉
        </div>
      ) : (
        <div className="fail-list">{children}</div>
      )}
    </section>
  );
}

function FailRow({
  title,
  path,
  error,
  when,
  badge,
  downloadHref,
  selected,
  onToggle,
  onRetry,
  retrying,
  disabled,
}: {
  title: string;
  path?: string;
  error: string;
  when: string;
  badge?: string;
  downloadHref?: string;
  selected?: boolean;
  onToggle?: () => void;
  onRetry?: () => void;
  retrying?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className={`fail-row${selected ? " selected" : ""}`}>
      <div className="fail-head">
        {onToggle && (
          <input
            type="checkbox"
            className="fail-check"
            checked={!!selected}
            onChange={onToggle}
            aria-label={`Select ${title}`}
          />
        )}
        <strong className="fail-title">{title}</strong>
        {badge && <span className="pill">{badge}</span>}
        <span className="spacer" />
        <span className="fail-when">
          {(() => {
            try {
              return new Date(when).toLocaleString("en-GB");
            } catch {
              return when;
            }
          })()}
        </span>
        {downloadHref && (
          <a
            className="btn btn-sm btn-icon"
            href={downloadHref}
            download
            title="Download the original file"
            aria-label="Download the original file"
          >
            {Icons.download}
          </a>
        )}
        {onRetry && (
          <button
            className="btn btn-sm"
            onClick={onRetry}
            disabled={disabled}
          >
            {retrying ? "…" : "Retry"}
          </button>
        )}
      </div>
      {path && path !== title && <div className="fail-path">{path}</div>}
      <div className="fail-err">{error}</div>
    </div>
  );
}

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
// survivor, what gets deleted, and whether the library entry is being relinked
// onto it (true when the survivor is an on-disk copy, not the indexed original).
type KeepTarget = {
  hash: string;
  keepPath: string;
  keepLabel: string;
  deletions: string[];
  relink: boolean;
};

// Deduplication audit with hands-on triage. Copies of the same bytes are grouped
// by content; each group lists every place that content lives — the library’s
// indexed copy (if any) and the extra copies sitting on disk. We make no
// assumption about which is "the original": the user picks the survivor with
// "Keep only this" (the rest are deleted; the library entry is relinked onto the
// survivor when it's an on-disk copy), so a single media remains. A path filter
// (e.g. "trash") isolates a folder, and on-disk copies can still be culled
// one-at-a-time or by selection. False collisions — distinct content that merely
// shares a partial hash — are never grouped or collapsed; they're listed apart,
// for audit only.
function DedupSection({
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
  // Pending confirmations: a list of on-disk paths to delete, or a keep-one pick.
  const [confirm, setConfirm] = useState<string[] | null>(null);
  const [keep, setKeep] = useState<KeepTarget | null>(null);
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
  const selectableShown = shownGroups.flatMap((g) =>
    g.copies.map((c) => c.abs_path),
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

  // Stage a "keep only this" decision: which copies would be deleted, and whether
  // keeping this one relinks the library entry (true when it's an on-disk copy).
  const askKeep = (g: DupGroup, keepPath: string, keepLabel: string) => {
    const members = [
      ...(g.existing?.abs_path ? [g.existing.abs_path] : []),
      ...g.copies.map((c) => c.abs_path),
    ];
    const deletions = members.filter((p) => p !== keepPath);
    const relink = !!(g.existing?.abs_path && keepPath !== g.existing.abs_path);
    setKeep({ hash: g.hash, keepPath, keepLabel, deletions, relink });
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
          }${skipped ? ` ${skipped} skipped (protected).` : ""}`,
        );
      }
      setKeep(null);
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
        on-disk copy), leaving a single media. False collisions — genuinely
        distinct content that merely shares a partial hash — are indexed
        separately and never collapsed; they’re listed below for audit only.
        {falseCollisions > 0
          ? ` ${falseCollisions} false collision(s) recovered.`
          : ""}
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
  busy,
}: {
  group: DupGroup;
  sel: Set<string>;
  onToggleSel: (p: string) => void;
  onKeep: (keepPath: string, keepLabel: string) => void;
  onDeleteCopy: (p: string) => void;
  busy: boolean;
}) {
  const { existing, copies, hash } = group;
  const thumb = existing?.has_thumb ? `/api/assets/${existing.id}/thumb` : null;
  const size = copies.find((c) => c.file_size != null)?.file_size ?? null;
  const total = (existing ? 1 : 0) + copies.length;
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
            label="In library"
            primary={`#${existing.id} · ${existing.filename ?? "—"}${
              existing.deleted ? " (soft-deleted)" : ""
            }`}
            path={existing.abs_path ?? "(path unknown)"}
            downloadHref={`/api/assets/${existing.id}/download`}
            canKeep={!!existing.abs_path}
            onKeep={() => {
              if (existing.abs_path)
                onKeep(
                  existing.abs_path,
                  `#${existing.id} · ${existing.filename ?? existing.abs_path}`,
                );
            }}
            busy={busy}
          />
        )}
        {copies.map((c) => (
          <MemberRow
            key={c.abs_path}
            label="On disk"
            sub={c.source}
            path={c.abs_path}
            downloadHref={`/api/failures/duplicates/file?path=${encodeURIComponent(
              c.abs_path,
            )}`}
            canKeep
            onKeep={() => onKeep(c.abs_path, c.abs_path)}
            selected={sel.has(c.abs_path)}
            onToggleSel={() => onToggleSel(c.abs_path)}
            onDelete={() => onDeleteCopy(c.abs_path)}
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

// A single copy within a group. The indexed library copy gets no checkbox and no
// blind "delete" (removing it has to go through "Keep only this", which relinks
// the asset); on-disk copies get both, plus the shared "Keep only this".
function MemberRow({
  label,
  sub,
  primary,
  path,
  downloadHref,
  canKeep,
  onKeep,
  selected,
  onToggleSel,
  onDelete,
  busy,
}: {
  label: string;
  sub?: string;
  primary?: string;
  path: string;
  downloadHref: string;
  canKeep: boolean;
  onKeep: () => void;
  selected?: boolean;
  onToggleSel?: () => void;
  onDelete?: () => void;
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
            title="Delete just this copy"
            aria-label="Delete just this copy"
          >
            {Icons.trash}
          </button>
        )}
        <button
          className="btn btn-sm"
          onClick={onKeep}
          disabled={busy || !canKeep}
          title="Keep only this copy and delete the others"
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

// Missing originals (cf. lib/integrity.ts): indexed assets whose file is gone
// from disk. The detector already auto-trashed them (reversible, `trashed`) —
// or only flagged them when a mass disappearance looked like an unmounted
// volume. Triage here:
//   - Re-check : re-stats the selection; whichever files answer again are
//     restored automatically (flag + auto-trash lifted).
//   - Restore  : puts the asset back in the library anyway (e.g. the detection
//     is known-wrong and the file will be back later).
//   - Purge    : the irreversible cleanup — drops the leftover derivatives and
//     stamps the row purged (there is no original left to lose).
//   - Verify integrity : queues the full sweep (sources + derivative objects).
function MissingSection({
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
      setMsg(
        r.ok
          ? `Purge queued for ${ids.length} asset(s) — leftover derivatives are removed and the rows stamped purged.`
          : `Error: ${d.error ?? "unknown"}`,
      );
      setSel(new Set());
      setConfirmPurge(null);
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
