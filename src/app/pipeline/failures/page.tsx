"use client";

// Centralized list of what has failed (scan / analyze / import), with the
// error message for debugging. Lives under /pipeline (the section chrome — heading
// + tabs — is provided by the layout). Retry is available three ways:
//   - per item   : the "Retry" button on each row,
//   - selected   : the checked rows ("Retry selected"),
//   - everything : the whole family ("Retry all").
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchJson } from "@/lib/fetchJson";
import { Icons } from "../../ui";

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
type DuplicateItem = {
  abs_path: string;
  content_hash: string;
  existing_asset_id: number | null;
  source: string;
  verified: boolean | null;
  hits: number;
  updated_at: string;
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

      <Section
        title="Deduplication"
        hint={`Files matched as duplicates by partial hash. False collisions (genuinely distinct content) are indexed anyway — never dropped — and flagged here for audit.${
          data && data.duplicates.falseCollisions > 0
            ? ` ${data.duplicates.falseCollisions} false collision(s) recovered.`
            : ""
        }`}
        count={data?.duplicates.count ?? 0}
      >
        {(data?.duplicates.items ?? []).map((it, i) => (
          <FailRow
            key={`u${it.abs_path}-${i}`}
            title={it.abs_path}
            error={`${it.source} · ${
              it.verified === false
                ? "FALSE collision → indexed separately (kept)"
                : it.verified === true
                  ? "confirmed duplicate (not reprocessed)"
                  : "unverified (existing file unreadable) — treated as duplicate"
            }${
              it.existing_asset_id ? ` · matched asset #${it.existing_asset_id}` : ""
            } · ${it.content_hash.slice(0, 12)}…`}
            when={it.updated_at}
            badge={
              it.verified === false
                ? "false collision"
                : it.hits > 1
                  ? `${it.hits}×`
                  : undefined
            }
          />
        ))}
      </Section>
    </section>
  );
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
