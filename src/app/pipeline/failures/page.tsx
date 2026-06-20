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
type Failures = {
  derivative: { count: number; items: DerivItem[] };
  scan: { count: number; items: ScanItem[] };
  import: { count: number; items: ImportItem[] };
  duplicates: {
    count: number;
    falseCollisions: number;
    items: DuplicateItem[];
  };
};

type Kind = "derivative" | "scan" | "import";
type Scope = { ids?: number[]; paths?: string[] };

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

  return (
    <section className="pl-section">
      <div className="filterbar">
        <span className="hint">
          Everything that failed (scan · analyze · import), in one place. Fix the
          cause, then retry per item, by selection, or by family.
        </span>
        <span className="spacer" />
        <button className="btn btn-sm" onClick={load}>
          Refresh
        </button>
      </div>

      {error && (
        <div className="error-box">
          <span>Couldn’t load failures: {error}</span>
          <button className="btn" onClick={load}>
            Retry
          </button>
        </div>
      )}
      {msg && <p className="hint">{msg}</p>}

      <RetrySection<number>
        title="Analyze (derivatives)"
        hint="Photo/video derivative generation failed — check the message, fix the cause (e.g. ffmpeg/codec), then retry."
        count={data?.derivative.count ?? 0}
        rows={derivRows}
        retryAllLabel="Retry all"
        prefix="derivative"
        busy={busy}
        onRetry={onRetryDeriv}
      />

      <RetrySection<string>
        title="Scan (indexing)"
        hint="Files that couldn’t be indexed (unreadable, corrupt, metadata error). Retry re-scans the affected roots."
        count={data?.scan.count ?? 0}
        rows={scanRows}
        retryAllLabel="Retry all"
        prefix="scan"
        busy={busy}
        onRetry={onRetryScan}
      />

      <Section
        title="Import"
        hint="Files that failed verification/filing. Failed files are quarantined in the inbox’s .failed/ folder; retry re-imports them (whole quarantine)."
        count={data?.import.count ?? 0}
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

      <DedupSection
        count={data?.duplicates.count ?? 0}
        falseCollisions={data?.duplicates.falseCollisions ?? 0}
        items={data?.duplicates.items ?? []}
        onChanged={load}
        setMsg={setMsg}
      />
    </section>
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

// Whether a duplicate row is a safe extra copy (an identical/unverifiable match
// that was NOT indexed) — the only kind we offer to hard-delete. A FALSE
// collision (verified === false) is distinct content that got indexed and kept,
// so deleting it would lose a real shot: shown, never deletable.
const isDeletable = (it: DuplicateItem) => it.verified !== false;

// Deduplication audit with hands-on triage. Each entry is one extra copy found
// on disk (the kept, indexed original is shown beside it for comparison). The
// user can: filter by path (e.g. "trash" to isolate Capture One's trash folder),
// expand a row to compare kept vs duplicate with a thumbnail, download the raw
// duplicate to verify it by hand, and delete the extra copies — one at a time or
// the whole filtered selection — always behind a confirmation.
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
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  const needle = filter.trim().toLowerCase();
  const shown = useMemo(
    () =>
      needle
        ? items.filter(
            (it) =>
              it.abs_path.toLowerCase().includes(needle) ||
              (it.existing?.abs_path ?? "").toLowerCase().includes(needle),
          )
        : items,
    [items, needle],
  );

  // Keep selection/expansion in sync with what's actually listed (items vanish
  // after a delete or a refresh) so a stale path is never carried around.
  const sig = items.map((i) => i.abs_path).join("\n");
  useEffect(() => {
    const live = new Set(items.map((i) => i.abs_path));
    const prune = (s: Set<string>) => {
      const next = new Set<string>();
      for (const p of s) if (live.has(p)) next.add(p);
      return next.size === s.size ? s : next;
    };
    setSel(prune);
    setExpanded(prune);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  const deletableShown = shown.filter(isDeletable);
  const allChecked =
    deletableShown.length > 0 && deletableShown.every((it) => sel.has(it.abs_path));
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
  const toggleExpand = (p: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });

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

  return (
    <section style={{ marginBottom: 28 }}>
      <div className="filterbar" style={{ marginBottom: 6 }}>
        {deletableShown.length > 0 && (
          <input
            ref={headRef}
            type="checkbox"
            className="fail-check"
            aria-label="Select all listed duplicates"
            checked={allChecked}
            onChange={(e) =>
              setSel(
                e.target.checked
                  ? new Set(deletableShown.map((it) => it.abs_path))
                  : new Set(),
              )
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
        Files matched as duplicates by partial hash. Each is an extra copy that
        was <strong>not</strong> indexed (the kept original is shown beside it);
        deleting one frees space without losing anything. False collisions
        (genuinely distinct content) are indexed anyway — never dropped — and
        flagged here for audit only.
        {falseCollisions > 0
          ? ` ${falseCollisions} false collision(s) recovered.`
          : ""}
      </p>

      {count === 0 ? (
        <div className="empty" style={{ padding: 16 }}>
          Nothing here. 🎉
        </div>
      ) : shown.length === 0 ? (
        <div className="empty" style={{ padding: 16 }}>
          No duplicate matches “{filter}”.
        </div>
      ) : (
        <div className="fail-list">
          {shown.map((it) => (
            <DuplicateRow
              key={it.abs_path}
              it={it}
              expanded={expanded.has(it.abs_path)}
              onToggleExpand={() => toggleExpand(it.abs_path)}
              selected={sel.has(it.abs_path)}
              onToggleSel={() => toggleSel(it.abs_path)}
              onDelete={() => setConfirm([it.abs_path])}
              busy={busy}
            />
          ))}
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
    </section>
  );
}

function DuplicateRow({
  it,
  expanded,
  onToggleExpand,
  selected,
  onToggleSel,
  onDelete,
  busy,
}: {
  it: DuplicateItem;
  expanded: boolean;
  onToggleExpand: () => void;
  selected: boolean;
  onToggleSel: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  const deletable = isDeletable(it);
  // The kept asset's thumbnail only stands in for the duplicate when the content
  // is the same. For a FALSE collision the two genuinely differ, so showing the
  // matched thumbnail would misrepresent this file — fall back to a placeholder.
  const thumb =
    deletable && it.existing?.has_thumb
      ? `/api/assets/${it.existing.id}/thumb`
      : null;
  const dlHref = `/api/failures/duplicates/file?path=${encodeURIComponent(
    it.abs_path,
  )}`;
  const status =
    it.verified === false
      ? "FALSE collision → indexed separately (kept)"
      : it.verified === true
        ? "confirmed duplicate"
        : "unverified (existing file unreadable) — treated as duplicate";

  return (
    <div className={`dup-row${selected ? " selected" : ""}`}>
      <div className="dup-head" onClick={onToggleExpand}>
        {deletable && (
          <input
            type="checkbox"
            className="fail-check"
            checked={selected}
            onClick={(e) => e.stopPropagation()}
            onChange={onToggleSel}
            aria-label={`Select ${it.abs_path}`}
          />
        )}
        <div className="pl-thumb" aria-hidden>
          {thumb ? (
            <LazyImage src={thumb} alt="" />
          ) : (
            <span className="pl-thumb-empty">{Icons.photos}</span>
          )}
        </div>
        <div className="dup-main">
          <div className="dup-path">{it.abs_path}</div>
          <div className="dup-sub">
            {it.source} · {status}
            {it.file_size != null ? ` · ${formatBytes(it.file_size)}` : ""} ·{" "}
            {it.content_hash.slice(0, 12)}…
          </div>
        </div>
        {it.verified === false ? (
          <span className="pill">false collision</span>
        ) : it.hits > 1 ? (
          <span className="pill">{it.hits}×</span>
        ) : null}
        <div className="dup-actions" onClick={(e) => e.stopPropagation()}>
          <a
            className="btn btn-sm btn-icon"
            href={dlHref}
            download
            title="Download this duplicate file to inspect it"
            aria-label="Download this duplicate file"
          >
            {Icons.download}
          </a>
          {deletable && (
            <button
              className="btn btn-sm btn-icon btn-danger"
              onClick={onDelete}
              disabled={busy}
              title="Delete this duplicate file from disk"
              aria-label="Delete this duplicate file"
            >
              {Icons.trash}
            </button>
          )}
          <span
            className="dup-chevron"
            style={{ transform: expanded ? "rotate(90deg)" : undefined }}
            aria-hidden
          >
            {Icons.chevronRight}
          </span>
        </div>
      </div>

      {expanded && (
        <div className="dup-body">
          <div className="dup-cmp">
            <div className="pl-thumb" aria-hidden>
              {thumb ? (
                <LazyImage src={thumb} alt="" />
              ) : (
                <span className="pl-thumb-empty">{Icons.photos}</span>
              )}
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="dup-cmp-label">Kept (in library)</div>
              {it.existing ? (
                <>
                  <div className="dup-cmp-name">
                    #{it.existing.id} · {it.existing.filename}
                    {it.existing.deleted ? " (soft-deleted)" : ""}
                  </div>
                  <div className="dup-cmp-path">{it.existing.abs_path}</div>
                  <a
                    className="btn btn-sm"
                    href={`/api/assets/${it.existing.id}/download`}
                    download
                    style={{ marginTop: 8 }}
                  >
                    {Icons.download}
                    <span>Download original</span>
                  </a>
                </>
              ) : (
                <div className="dup-cmp-path">
                  No indexed asset linked (matched a file already on disk at the
                  import destination).
                </div>
              )}
            </div>
          </div>

          <div className="dup-cmp">
            <div className="pl-thumb" aria-hidden>
              {thumb ? (
                <LazyImage src={thumb} alt="" />
              ) : (
                <span className="pl-thumb-empty">{Icons.photos}</span>
              )}
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="dup-cmp-label">
                Duplicate copy{deletable ? "" : " — kept (distinct)"}
              </div>
              <div className="dup-cmp-path">{it.abs_path}</div>
              <div className="dup-actions" style={{ marginTop: 8 }}>
                <a className="btn btn-sm" href={dlHref} download>
                  {Icons.download}
                  <span>Download</span>
                </a>
                {deletable && (
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={onDelete}
                    disabled={busy}
                  >
                    {Icons.trash}
                    <span>Delete</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
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
