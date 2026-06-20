"use client";

// Reusable, paginated asset list for the Pipeline triage pages (Media / Analyzed
// / Pending). It polls /api/assets with a caller-supplied query (e.g.
// derivative_status=ready) and renders one row per asset — thumbnail, name, path,
// status — with a configurable set of row actions. Mutations update the list
// optimistically so the page reflects the action without a full reload.
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchJson } from "@/lib/fetchJson";
import {
  deleteAssets,
  regenerateAssets,
  skipAssets,
} from "@/lib/assetActions";
import type { AssetGridRow } from "@/lib/types";
import { EmptyState, Icons } from "../ui";

export type RowAction = "view" | "regenerate" | "skip" | "delete";

type Page = { assets: AssetGridRow[]; next_cursor: string | null };

// Each mutating action: how it's labelled, whether it needs a confirm, and
// whether a success removes the row from *this* list (true when the action moves
// the asset out of the page's filter, e.g. delete everywhere, skip on Pending).
const MUTATIONS: Record<
  Exclude<RowAction, "view">,
  {
    label: string;
    danger?: boolean;
    confirm?: string;
    removes: boolean;
    run: (id: number) => Promise<unknown>;
    done: string;
  }
> = {
  regenerate: {
    label: "↻ Regenerate",
    removes: false,
    run: (id) => regenerateAssets([id]),
    done: "Re-queued derivative generation.",
  },
  skip: {
    label: "Skip",
    confirm:
      "Skip this item? It will be taken out of the analyze pipeline until you regenerate it. (The original file is untouched.)",
    removes: true,
    run: (id) => skipAssets([id]),
    done: "Skipped — removed from the pipeline.",
  },
  delete: {
    label: "🗑 Delete",
    danger: true,
    confirm:
      "Delete this item from the library? It is hidden from every view, but the original file on disk is never touched (reversible).",
    removes: true,
    run: (id) => deleteAssets([id]),
    done: "Deleted (original untouched).",
  },
};

export default function PipelineAssetList({
  query,
  actions,
  hint,
  emptyTitle,
  emptyHint,
  pollMs = 8000,
}: {
  query: string;
  actions: RowAction[];
  hint?: string;
  emptyTitle: string;
  emptyHint?: string;
  pollMs?: number;
}) {
  const [items, setItems] = useState<AssetGridRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [msg, setMsg] = useState("");
  // Once the user pages past the first batch we stop auto-refreshing so polling
  // never yanks the list back to the top mid-scroll.
  const expanded = useRef(false);
  // Read inside the poll without re-arming the interval (which would also reset
  // the loaded pages) every time an action starts/finishes.
  const busyRef = useRef<number | null>(null);
  busyRef.current = busy;

  const loadFirst = useCallback(async () => {
    try {
      const d = await fetchJson<Page>(`/api/assets?${query}`);
      setItems(d.assets);
      setCursor(d.next_cursor);
      setError(null);
      expanded.current = false;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [query]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    expanded.current = true;
    try {
      const d = await fetchJson<Page>(
        `/api/assets?${query}&cursor=${encodeURIComponent(cursor)}`,
      );
      setItems((prev) => [...prev, ...d.assets]);
      setCursor(d.next_cursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, query]);

  useEffect(() => {
    loadFirst();
    const t = setInterval(() => {
      if (!expanded.current && busyRef.current == null) loadFirst();
    }, pollMs);
    return () => clearInterval(t);
  }, [loadFirst, pollMs]);

  const run = useCallback(
    async (id: number, action: Exclude<RowAction, "view">) => {
      const m = MUTATIONS[action];
      if (busy != null) return;
      if (m.confirm && !window.confirm(m.confirm)) return;
      setBusy(id);
      setMsg("");
      try {
        await m.run(id);
        setMsg(m.done);
        if (m.removes) setItems((prev) => prev.filter((it) => it.id !== id));
      } catch (e) {
        setMsg(`Error: ${(e as Error).message}`);
      } finally {
        setBusy(null);
      }
    },
    [busy],
  );

  return (
    <section className="pl-section">
      <div className="filterbar">
        {hint && <span className="hint">{hint}</span>}
        <span className="spacer" />
        <button className="btn btn-sm" onClick={loadFirst} disabled={loading}>
          Refresh
        </button>
      </div>

      {error && (
        <div className="error-box">
          <span>Couldn’t load: {error}</span>
          <button className="btn" onClick={loadFirst}>
            Retry
          </button>
        </div>
      )}
      {msg && <p className="hint">{msg}</p>}

      {loading ? (
        <div className="spinner">Loading…</div>
      ) : items.length === 0 ? (
        <EmptyState icon={Icons.photos} title={emptyTitle} hint={emptyHint} />
      ) : (
        <>
          <div className="pl-list">
            {items.map((it) => (
              <AssetRow
                key={it.id}
                asset={it}
                actions={actions}
                busy={busy === it.id}
                disabled={busy != null}
                onRun={run}
              />
            ))}
          </div>
          {cursor && (
            <div className="pl-more">
              <button
                className="btn"
                onClick={loadMore}
                disabled={loadingMore}
              >
                {loadingMore ? "…" : "Load more"}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function AssetRow({
  asset,
  actions,
  busy,
  disabled,
  onRun,
}: {
  asset: AssetGridRow;
  actions: RowAction[];
  busy: boolean;
  disabled: boolean;
  onRun: (id: number, action: Exclude<RowAction, "view">) => void;
}) {
  const ready = asset.derivative_status === "ready";
  const proxyHref = `/api/assets/${asset.id}/proxy`;
  return (
    <div className="pl-row">
      {asset.thumb_key ? (
        <a
          href={proxyHref}
          target="_blank"
          rel="noreferrer"
          className="pl-thumb"
          title="Open full preview"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/api/assets/${asset.id}/thumb`} alt={asset.filename} loading="lazy" />
        </a>
      ) : (
        <div className="pl-thumb pl-thumb-empty" aria-hidden>
          {asset.media_type === "video" ? "▶" : "▢"}
        </div>
      )}

      <div className="pl-main">
        <div className="pl-name">
          {asset.filename}
          <StatusPill status={asset.derivative_status} />
        </div>
        <div className="pl-path">{asset.abs_path}</div>
        <div className="pl-meta">
          {asset.media_type}
          {asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : ""}
          {" · "}
          {formatWhen(asset.updated_at)}
        </div>
      </div>

      <div className="pl-actions">
        {actions.includes("view") &&
          (ready ? (
            <a
              className="btn btn-sm"
              href={proxyHref}
              target="_blank"
              rel="noreferrer"
              title="Open full preview"
            >
              View
            </a>
          ) : (
            <span
              className="btn btn-sm pl-disabled"
              aria-disabled="true"
              title="No derivative yet"
            >
              View
            </span>
          ))}
        {(["regenerate", "skip", "delete"] as const)
          .filter((k) => actions.includes(k))
          .map((k) => (
            <button
              key={k}
              className={`btn btn-sm${MUTATIONS[k].danger ? " btn-reject" : ""}`}
              onClick={() => onRun(asset.id, k)}
              disabled={disabled}
            >
              {busy ? "…" : MUTATIONS[k].label}
            </button>
          ))}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "ready"
      ? "ready"
      : status === "error"
        ? "error"
        : status === "pending" || status === "processing"
          ? "pending"
          : "";
  return <span className={`pill ${tone}`}>{status}</span>;
}

function formatWhen(v: string | null): string {
  if (!v) return "—";
  try {
    return new Date(v).toLocaleString("en-GB");
  } catch {
    return v;
  }
}
