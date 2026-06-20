"use client";

// Reusable, paginated asset list for the Pipeline triage pages (Media / Analyzed
// / Pending). It polls /api/assets with a caller-supplied query (e.g.
// derivative_status=ready) and renders one card per asset. Each card stacks:
//   1. the filename + status pill,
//   2. the full absolute path (never truncated — debugging needs the real path),
//   3. the thumbnail, a line of details, and the actions.
// "View" opens the shared MediaViewer; "Download" pulls the original file (handy
// for items with no derivative yet); the rest (regenerate / skip / delete) live
// in a compact overflow menu. Mutations update the list optimistically.
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchJson } from "@/lib/fetchJson";
import {
  deleteAssets,
  regenerateAssets,
  skipAssets,
} from "@/lib/assetActions";
import type { AssetGridRow } from "@/lib/types";
import { EmptyState, Icons } from "../ui";
import MediaViewer from "../MediaViewer";
import ActionMenu, { type MenuItem } from "./ActionMenu";

export type RowAction = "view" | "download" | "regenerate" | "skip" | "delete";

type Mutation = Exclude<RowAction, "view" | "download">;

type Page = { assets: AssetGridRow[]; next_cursor: string | null };

// Each mutating action: how it's labelled, its menu glyph, whether it needs a
// confirm, and whether a success removes the row from *this* list (true when the
// action moves the asset out of the page's filter, e.g. delete everywhere, skip
// on Pending).
const MUTATIONS: Record<
  Mutation,
  {
    label: string;
    glyph: string;
    danger?: boolean;
    confirm?: string;
    removes: boolean;
    run: (id: number) => Promise<unknown>;
    done: string;
  }
> = {
  regenerate: {
    label: "Regenerate",
    glyph: "↻",
    removes: false,
    run: (id) => regenerateAssets([id]),
    done: "Re-queued derivative generation.",
  },
  skip: {
    label: "Skip",
    glyph: "⊘",
    confirm:
      "Skip this item? It will be taken out of the analyze pipeline until you regenerate it. (The original file is untouched.)",
    removes: true,
    run: (id) => skipAssets([id]),
    done: "Skipped — removed from the pipeline.",
  },
  delete: {
    label: "Delete",
    glyph: "🗑",
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
  const [viewer, setViewer] = useState<number | null>(null);
  // Once the user pages past the first batch we stop auto-refreshing so polling
  // never yanks the list back to the top mid-scroll.
  const expanded = useRef(false);
  // Read inside the poll without re-arming the interval (which would also reset
  // the loaded pages) every time an action starts/finishes.
  const busyRef = useRef<number | null>(null);
  busyRef.current = busy;
  // Pause polling while the viewer is open so item indices don't shift under it.
  const viewerRef = useRef<number | null>(null);
  viewerRef.current = viewer;

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
      if (!expanded.current && busyRef.current == null && viewerRef.current == null) {
        loadFirst();
      }
    }, pollMs);
    return () => clearInterval(t);
  }, [loadFirst, pollMs]);

  // Returns whether the action actually ran (false if the confirm was dismissed).
  const run = useCallback(
    async (id: number, action: Mutation): Promise<boolean> => {
      const m = MUTATIONS[action];
      if (busy != null) return false;
      if (m.confirm && !window.confirm(m.confirm)) return false;
      setBusy(id);
      setMsg("");
      try {
        await m.run(id);
        setMsg(m.done);
        if (m.removes) setItems((prev) => prev.filter((it) => it.id !== id));
        return true;
      } catch (e) {
        setMsg(`Error: ${(e as Error).message}`);
        return false;
      } finally {
        setBusy(null);
      }
    },
    [busy],
  );

  // From the viewer: run a mutation and, if it removes the asset, close the viewer.
  const runFromViewer = useCallback(
    async (id: number, action: Mutation) => {
      const ran = await run(id, action);
      if (ran && MUTATIONS[action].removes) setViewer(null);
    },
    [run],
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
            {items.map((it, idx) => (
              <AssetRow
                key={it.id}
                asset={it}
                actions={actions}
                busy={busy === it.id}
                disabled={busy != null}
                onRun={run}
                onView={() => setViewer(idx)}
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

      {viewer != null && items[viewer] && (
        <MediaViewer
          items={items}
          index={viewer}
          onIndexChange={setViewer}
          onClose={() => setViewer(null)}
          renderActions={(it) => (
            <>
              <a className="btn" href={`/api/assets/${it.id}/download`} download>
                {Icons.download} Download
              </a>
              {(["regenerate", "skip", "delete"] as const)
                .filter((k) => actions.includes(k))
                .map((k) => (
                  <button
                    key={k}
                    className={`btn${MUTATIONS[k].danger ? " btn-reject" : ""}`}
                    disabled={busy != null}
                    onClick={() => runFromViewer(it.id, k)}
                  >
                    {MUTATIONS[k].glyph} {MUTATIONS[k].label}
                  </button>
                ))}
            </>
          )}
        />
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
  onView,
}: {
  asset: AssetGridRow;
  actions: RowAction[];
  busy: boolean;
  disabled: boolean;
  onRun: (id: number, action: Mutation) => void;
  onView: () => void;
}) {
  const canView = actions.includes("view");
  const hasThumb = Boolean(asset.thumb_key);

  const menuItems: MenuItem[] = (["regenerate", "skip", "delete"] as const)
    .filter((k) => actions.includes(k))
    .map((k) => ({
      key: k,
      label: MUTATIONS[k].label,
      icon: MUTATIONS[k].glyph,
      danger: MUTATIONS[k].danger,
      disabled,
      onSelect: () => onRun(asset.id, k),
    }));

  const Thumb = hasThumb ? (
    <button
      type="button"
      className="pl-thumb"
      onClick={canView ? onView : undefined}
      disabled={!canView}
      title={canView ? "Open the viewer" : asset.filename}
      aria-label={canView ? `View ${asset.filename}` : asset.filename}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`/api/assets/${asset.id}/thumb`} alt={asset.filename} loading="lazy" />
    </button>
  ) : (
    <div className="pl-thumb pl-thumb-empty" aria-hidden>
      {asset.media_type === "video" ? "▶" : "▢"}
    </div>
  );

  return (
    <div className="pl-card">
      <div className="pl-head">
        <span className="pl-name">{asset.filename}</span>
        <StatusPill status={asset.derivative_status} />
      </div>

      <div className="pl-path" title={asset.abs_path}>
        {asset.abs_path}
      </div>

      <div className="pl-body">
        {Thumb}
        <div className="pl-meta">
          {asset.media_type}
          {asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : ""}
          {" · "}
          {formatWhen(asset.updated_at)}
        </div>
        <div className="pl-actions">
          {canView && (
            <button
              className="btn btn-sm"
              onClick={onView}
              title="Open the viewer"
            >
              {Icons.view} View
            </button>
          )}
          {actions.includes("download") && (
            <a
              className="btn btn-sm"
              href={`/api/assets/${asset.id}/download`}
              download
              title="Download the original file"
            >
              {Icons.download} Download
            </a>
          )}
          <ActionMenu items={menuItems} disabled={disabled || busy} label={asset.filename} />
        </div>
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
