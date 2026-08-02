"use client";

// Building blocks shared by the failure-family pages: the page shell
// (pull-to-refresh + load error + action feedback) and the generic listing
// sections with their retry/select plumbing.
import { useEffect, useRef, useState } from "react";
import { Icons } from "../../../ui";
import PullToRefresh from "../../../PullToRefresh";
import type { RowData } from "./model";

// Common frame around a family page: the touch pull-to-refresh, the load
// error (with a retry) and the one-line feedback of the last action. The
// family nav itself lives one level up, in the section layout.
export function FamilyShell({
  onRefresh,
  error,
  msg,
  children,
}: {
  onRefresh: () => Promise<unknown> | void;
  error: string | null;
  msg: string;
  children: React.ReactNode;
}) {
  return (
    <PullToRefresh className="pl-section" onRefresh={onRefresh}>
      {error && (
        <div className="error-box">
          <span>Couldn’t load failures: {error}</span>
          <button className="btn" onClick={onRefresh}>
            Retry
          </button>
        </div>
      )}
      {msg && <p className="hint">{msg}</p>}
      {children}
    </PullToRefresh>
  );
}

// A failure family with selectable rows: per-row retry, "Retry selected"
// (checked rows) and "Retry all" (the whole family, server-side — even rows
// beyond the listing cap).
export function RetrySection<K extends string | number>({
  title,
  hint,
  count,
  rows,
  retryAllLabel,
  prefix,
  busy,
  onRetry,
  onDelete,
}: {
  title: string;
  hint: React.ReactNode;
  count: number;
  rows: RowData<K>[];
  retryAllLabel: string;
  prefix: string;
  busy: string | null;
  onRetry: (keys: K[] | null, busyKey: string) => void;
  // Optional destructive action (derivative family only): soft-delete the
  // picked keys, or `null` for the whole family. The parent stages the
  // confirmation; here we only surface the buttons.
  onDelete?: (keys: K[] | null) => void;
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

  const deleteSelected = () => {
    const keys = [...sel];
    if (!keys.length || !onDelete) return;
    onDelete(keys);
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
        {onDelete && (
          <>
            <button
              className="btn btn-danger"
              onClick={deleteSelected}
              disabled={anyBusy || sel.size === 0}
              title="Move the selected media to the trash (never touches a file)"
            >
              {Icons.trash}
              <span>Delete selected ({sel.size})</span>
            </button>
            <button
              className="btn btn-danger"
              onClick={() => onDelete(null)}
              disabled={anyBusy || count === 0}
              title="Move every media in this list to the trash (never touches a file)"
            >
              {Icons.trash}
              <span>Delete all</span>
            </button>
          </>
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
                onDelete={onDelete ? () => onDelete([key]) : undefined}
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
export function Section({
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

export function FailRow({
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
  onDelete,
  deleting,
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
  onDelete?: () => void;
  deleting?: boolean;
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
        {/* All actions share one flex box so the icon-only download and the
            text Retry/Delete buttons line up at the same height. */}
        <span className="fail-actions">
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
            <button className="btn btn-sm" onClick={onRetry} disabled={disabled}>
              {retrying ? "…" : "Retry"}
            </button>
          )}
          {onDelete && (
            <button
              className="btn btn-sm btn-icon btn-danger"
              onClick={onDelete}
              disabled={disabled}
              title="Move this media to the trash (never touches a file)"
              aria-label="Move this media to the trash"
            >
              {deleting ? "…" : Icons.trash}
            </button>
          )}
        </span>
      </div>
      {path && path !== title && <div className="fail-path">{path}</div>}
      <div className="fail-err">{error}</div>
    </div>
  );
}
