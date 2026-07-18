"use client";

// Reusable, paginated media browser for the Pipeline triage pages (Media /
// Pending). It polls /api/assets with a caller-supplied base query (e.g.
// derivative_status=pending,processing) and offers three interchangeable views
// over the same feed — all sharing one MediaViewer, one pagination cursor and
// one set of row actions:
//
//   • List   — the detailed triage card (filename, full untruncated path,
//              thumbnail, meta, inline icon actions). Best for debugging a
//              specific item.
//   • Grid   — a virtualized thumbnail wall (react-window) that stays smooth at
//              100k+ media: dense, scannable, infinite-scroll. Opens the viewer.
//   • Folder — browse by root ▸ session (via /api/tree), then see that folder's
//              media in the grid — so you navigate instead of scrolling forever.
//
// A sort control (capture date vs processed date, either direction) and an
// optional derivative-status filter (All / Ready / Pending / Error / Skipped)
// ride the toolbar; the status filter subsumes what used to be a separate
// "Analyzed" page (Ready is just one status). View, sort and grid density are
// persisted to localStorage so the choice sticks across pages and visits.
//
// Actions render as a compact icon "bento" on the list rows and as buttons in
// the viewer: "View" opens the viewer; "Download" pulls the original file;
// regenerate / skip / delete sit beside them (delete carries a danger tint).
// Mutations update the list optimistically.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { fetchJson } from "@/lib/fetchJson";
import {
  deleteAssets,
  regenerateAssets,
  skipAssets,
} from "@/lib/assetActions";
import type { AssetGridRow } from "@/lib/types";
import { EmptyState, Icons } from "../ui";
import MediaViewer from "../MediaViewer";
import PullToRefresh from "../PullToRefresh";
import VirtualGrid, { type GalleryAsset } from "../gallery/VirtualGrid";
import { useStats } from "../useStats";

export type RowAction = "view" | "download" | "regenerate" | "skip" | "delete";

type Mutation = Exclude<RowAction, "view" | "download">;

type Page = { assets: AssetGridRow[]; next_cursor: string | null };

// The interchangeable views. `folder` is offered only when the caller allows it
// (it makes no sense on a queue-scoped page like Pending's default).
type View = "list" | "grid" | "folder";

// Sort maps onto the two orderings /api/assets understands: the capture
// timeline (default) or the "most recently touched" processed order (updated_at,
// via `sort=recent`). Direction flips both via `sort_dir`.
type SortField = "captured" | "processed";
type SortDir = "asc" | "desc";
type Sort = { field: SortField; dir: SortDir };

// Derivative-status facet. Each maps to a query fragment appended to the base
// query. `all` adds nothing (every status), matching the old "Media" page.
type StatusKey = "all" | "ready" | "pending" | "error" | "skipped";
const STATUS_ORDER: StatusKey[] = [
  "all",
  "ready",
  "pending",
  "error",
  "skipped",
];
const STATUS_LABEL: Record<StatusKey, string> = {
  all: "All",
  ready: "Ready",
  pending: "Pending",
  error: "Error",
  skipped: "Skipped",
};
const STATUS_QS: Record<StatusKey, string> = {
  all: "",
  ready: "derivative_status=ready",
  pending: "derivative_status=pending,processing",
  error: "derivative_status=error",
  skipped: "derivative_status=skipped",
};

// Grid density: target cell width (px). Smaller → more media per row.
const GRID_SIZES = [120, 160, 210];
const DEFAULT_DENSITY = 1;

// Shared localStorage keys so the view/sort/density choice is one preference
// across every Pipeline browser (Media, Pending) — the user picks Grid once and
// it sticks everywhere.
const KEY_VIEW = "winnow.pipeline.view";
const KEY_SORT = "winnow.pipeline.sort";
const KEY_DENSITY = "winnow.pipeline.density";

// Each mutating action: how it's labelled, its icon, whether it needs a confirm,
// and whether a success removes the row from *this* list (true when the action
// moves the asset out of the page's filter, e.g. delete everywhere, skip on
// Pending).
const MUTATIONS: Record<
  Mutation,
  {
    label: string;
    icon: ReactNode;
    danger?: boolean;
    confirm?: string;
    removes: boolean;
    run: (id: number) => Promise<unknown>;
    done: string;
  }
> = {
  regenerate: {
    label: "Regenerate",
    icon: Icons.regenerate,
    removes: false,
    run: (id) => regenerateAssets([id]),
    done: "Re-queued derivative generation.",
  },
  skip: {
    label: "Skip",
    icon: Icons.skip,
    confirm:
      "Skip this item? It will be taken out of the analyze pipeline until you regenerate it. (The original file is untouched.)",
    removes: true,
    run: (id) => skipAssets([id]),
    done: "Skipped — removed from the pipeline.",
  },
  delete: {
    label: "Delete",
    icon: Icons.trash,
    danger: true,
    confirm:
      "Delete this item from the library? It is hidden from every view, but the original file on disk is never touched (reversible).",
    removes: true,
    run: (id) => deleteAssets([id]),
    done: "Deleted (original untouched).",
  },
};

// One node of the lazy filesystem tree (cf. /api/tree/fs): a real directory
// holding indexed media, its recursive count, and whether it has subdirectories
// to expand into.
type FsNode = {
  path: string;
  name: string;
  count: number;
  expandable: boolean;
};

// SSR-safe persisted state: renders the default on the server and first client
// paint (no hydration drift), restores the saved value on mount, and writes back
// on change. Mirrors the gallery's density/layout persistence.
function usePersisted<T extends string>(
  key: string,
  initial: T,
  parse: (raw: string) => T | null,
): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw != null) {
        const v = parse(raw);
        if (v != null) setValue(v);
      }
    } catch {
      /* storage disabled: keep the default */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(key, v);
      } catch {
        /* storage disabled: non-persisted */
      }
    },
    [key],
  );
  return [value, set];
}

// Gives the grid a definite pixel height so react-window can virtualize inside
// the pipeline's scroll container (which sizes to content, not the viewport).
// Measures the element's top edge and fills to the bottom of the window; recomputed
// on resize and whenever the chrome above it might have reflowed (`dep`).
function useFillHeight(active: boolean, dep: unknown): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [h, setH] = useState(420);
  useEffect(() => {
    if (!active) return;
    const measure = () => {
      const el = ref.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      setH(Math.max(280, Math.floor(window.innerHeight - top - 16)));
    };
    measure();
    const raf = requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(measure)
        : null;
    if (ro && document.body) ro.observe(document.body);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", measure);
      ro?.disconnect();
    };
  }, [active, dep]);
  return [ref, h];
}

export default function PipelineAssetList({
  query,
  actions,
  hint,
  emptyTitle,
  emptyHint,
  pollMs = 8000,
  views = ["list", "grid"],
  showStatus = false,
  defaultSort = { field: "captured", dir: "desc" },
  storageKey = "pipeline",
}: {
  /** Base filters, ANDed with the sort/status/folder selections (e.g. the
   *  Pending page fixes `derivative_status=pending,processing`). */
  query: string;
  actions: RowAction[];
  hint?: string;
  emptyTitle: string;
  emptyHint?: string;
  pollMs?: number;
  /** Which views to offer (segmented control hidden when only one). */
  views?: View[];
  /** Show the derivative-status facet (the Media browser; folds in "Analyzed"). */
  showStatus?: boolean;
  /** Sort used until the user picks one (persisted thereafter). */
  defaultSort?: Sort;
  /** Namespaces the status query param seeded from the URL. */
  storageKey?: string;
}) {
  const [items, setItems] = useState<AssetGridRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [msg, setMsg] = useState("");
  const [viewer, setViewer] = useState<number | null>(null);

  // View / sort / density: persisted preferences shared across Pipeline pages.
  const [view, setView] = usePersisted<View>(KEY_VIEW, views[0], (raw) =>
    views.includes(raw as View) ? (raw as View) : null,
  );
  const [sortRaw, setSortRaw] = usePersisted<string>(
    KEY_SORT,
    `${defaultSort.field}:${defaultSort.dir}`,
    (raw) => (/^(captured|processed):(asc|desc)$/.test(raw) ? raw : null),
  );
  const [density, setDensity] = usePersisted<string>(
    KEY_DENSITY,
    String(DEFAULT_DENSITY),
    (raw) => (/^[0-2]$/.test(raw) ? raw : null),
  );
  const [fp, fn] = sortRaw.split(":");
  const sort: Sort = { field: fp as SortField, dir: fn as SortDir };
  const setSort = (s: Sort) => setSortRaw(`${s.field}:${s.dir}`);
  const targetWidth = GRID_SIZES[Number(density)] ?? GRID_SIZES[DEFAULT_DENSITY];

  // Status facet (Media only). Seeded from the URL so the overview counter and
  // the old /pipeline/analyzed route can deep-link (e.g. ?status=ready), then
  // reflected back to the URL so the view is shareable.
  const [status, setStatusState] = useState<StatusKey>("all");
  useEffect(() => {
    if (!showStatus) return;
    try {
      const sp = new URLSearchParams(window.location.search);
      const s = sp.get("status");
      if (s && STATUS_ORDER.includes(s as StatusKey))
        setStatusState(s as StatusKey);
      const so = sp.get("sort");
      if (so === "processed" || so === "captured")
        setSortRaw(`${so}:${sort.dir}`);
    } catch {
      /* no window / bad URL: keep defaults */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showStatus]);
  const setStatus = (s: StatusKey) => {
    setStatusState(s);
    try {
      const sp = new URLSearchParams(window.location.search);
      if (s === "all") sp.delete("status");
      else sp.set("status", s);
      const qs = sp.toString();
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${qs ? `?${qs}` : ""}`,
      );
    } catch {
      /* non-fatal: the in-memory filter still applies */
    }
  };

  // Folder-view selection: the absolute directory path whose subtree scopes the
  // grid below the tree. Null until the user picks a folder.
  const [folderPath, setFolderPath] = useState<string | null>(null);

  // Once the user pages past the first batch we stop auto-refreshing so polling
  // never yanks the list back to the top mid-scroll.
  const expanded = useRef(false);
  const busyRef = useRef<number | null>(null);
  busyRef.current = busy;
  const viewerRef = useRef<number | null>(null);
  viewerRef.current = viewer;

  // The effective query: base + status facet + sort + (folder view) scope.
  const sortQS =
    (sort.field === "processed" ? "sort=recent&" : "") +
    (sort.dir === "asc" ? "sort_dir=asc" : "");
  const statusQS = showStatus ? STATUS_QS[status] : "";
  const scopeQS =
    view === "folder" && folderPath
      ? `under=${encodeURIComponent(folderPath)}`
      : "";
  const fullQuery = useMemo(
    () => [query, statusQS, sortQS, scopeQS].filter(Boolean).join("&"),
    [query, statusQS, sortQS, scopeQS],
  );

  // In Folder view we only fetch media once a folder is picked; otherwise the
  // grid would eagerly pull the whole (100k) library behind the tree.
  const shouldLoad = view !== "folder" || folderPath != null;

  const loadFirst = useCallback(async () => {
    if (!shouldLoad) {
      setItems([]);
      setCursor(null);
      setLoading(false);
      return;
    }
    try {
      const d = await fetchJson<Page>(`/api/assets?${fullQuery}`);
      setItems(d.assets);
      setCursor(d.next_cursor);
      setError(null);
      expanded.current = false;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [fullQuery, shouldLoad]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    expanded.current = true;
    try {
      const d = await fetchJson<Page>(
        `/api/assets?${fullQuery}&cursor=${encodeURIComponent(cursor)}`,
      );
      setItems((prev) => [...prev, ...d.assets]);
      setCursor(d.next_cursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, fullQuery]);

  // Reload the first page whenever the effective query changes (view/sort/status
  // /scope), and keep polling the first page while the user hasn't paged deeper.
  useEffect(() => {
    setLoading(true);
    loadFirst();
    const t = setInterval(() => {
      if (
        !expanded.current &&
        busyRef.current == null &&
        viewerRef.current == null
      ) {
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

  const runFromViewer = useCallback(
    async (id: number, action: Mutation) => {
      const ran = await run(id, action);
      if (ran && MUTATIONS[action].removes) setViewer(null);
    },
    [run],
  );

  const hasMore = cursor != null;

  // Height for the virtualized grid (grid view, or folder view once scoped).
  const gridActive =
    view === "grid" || (view === "folder" && folderPath != null);
  const [gridRef, gridH] = useFillHeight(
    gridActive,
    `${view}:${!!hint}:${status}:${folderPath ?? ""}`,
  );

  const grid = (
    <div
      ref={gridRef}
      className="pl-grid-wrap"
      style={{ height: gridH, display: "flex" }}
    >
      {loading ? (
        <div className="spinner">Loading…</div>
      ) : items.length === 0 ? (
        <EmptyState icon={Icons.photos} title={emptyTitle} hint={emptyHint} />
      ) : (
        <VirtualGrid
          items={items as unknown as GalleryAsset[]}
          hasMore={hasMore}
          loading={loadingMore}
          loadMore={loadMore}
          onOpen={(idx) => setViewer(idx)}
          targetWidth={targetWidth}
        />
      )}
    </div>
  );

  const list = loading ? (
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
      {hasMore && (
        <div className="pl-more">
          <button className="btn" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? "…" : "Load more"}
          </button>
        </div>
      )}
    </>
  );

  return (
    <PullToRefresh className="pl-section" onRefresh={loadFirst}>
      <div className="filterbar pl-toolbar">
        {hint && <span className="hint pl-hint">{hint}</span>}
        <span className="spacer" />
        <SortControl sort={sort} onChange={setSort} />
        {view === "grid" && (
          <DensityControl density={Number(density)} onChange={(d) => setDensity(String(d))} />
        )}
        {views.length > 1 && (
          <ViewSwitch views={views} active={view} onSelect={setView} />
        )}
        <button className="btn btn-sm" onClick={loadFirst} disabled={loading}>
          Refresh
        </button>
      </div>

      {showStatus && (
        <StatusChips status={status} onSelect={setStatus} />
      )}

      {error && (
        <div className="error-box">
          <span>Couldn’t load: {error}</span>
          <button className="btn" onClick={loadFirst}>
            Retry
          </button>
        </div>
      )}
      {msg && <p className="hint">{msg}</p>}

      {view === "folder" ? (
        <FolderView
          baseQuery={[query, statusQS].filter(Boolean).join("&")}
          selected={folderPath}
          onSelect={setFolderPath}
        >
          {folderPath ? grid : null}
        </FolderView>
      ) : view === "grid" ? (
        grid
      ) : (
        list
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
                    {MUTATIONS[k].icon} {MUTATIONS[k].label}
                  </button>
                ))}
            </>
          )}
        />
      )}
    </PullToRefresh>
  );
}

// Segmented view picker (List / Grid / Folder), reusing the gallery toolbar's
// segmented-control styling.
function ViewSwitch({
  views,
  active,
  onSelect,
}: {
  views: View[];
  active: View;
  onSelect: (v: View) => void;
}) {
  const icon: Record<View, ReactNode> = {
    list: Icons.viewList,
    grid: Icons.viewCard,
    folder: Icons.folder,
  };
  const label: Record<View, string> = {
    list: "List",
    grid: "Grid",
    folder: "Folder",
  };
  return (
    <div className="view-toggle" role="group" aria-label="View">
      {views.map((v) => (
        <button
          key={v}
          className={`view-btn${active === v ? " active" : ""}`}
          onClick={() => onSelect(v)}
          aria-pressed={active === v}
          title={`${label[v]} view`}
        >
          {icon[v]}
          <span className="pl-view-label">{label[v]}</span>
        </button>
      ))}
    </div>
  );
}

// Sort field (capture vs processed order) + a direction toggle.
function SortControl({
  sort,
  onChange,
}: {
  sort: Sort;
  onChange: (s: Sort) => void;
}) {
  return (
    <div className="pl-sort">
      <select
        className="input pl-sort-field"
        value={sort.field}
        onChange={(e) =>
          onChange({ ...sort, field: e.target.value as SortField })
        }
        aria-label="Sort by"
        title="Sort by"
      >
        <option value="captured">Capture date</option>
        <option value="processed">Processed date</option>
      </select>
      <button
        className="btn btn-sm btn-icon"
        onClick={() =>
          onChange({ ...sort, dir: sort.dir === "asc" ? "desc" : "asc" })
        }
        title={sort.dir === "asc" ? "Ascending (oldest first)" : "Descending (newest first)"}
        aria-label={`Sort direction: ${sort.dir === "asc" ? "ascending" : "descending"}`}
      >
        {sort.dir === "asc" ? Icons.arrowUp : Icons.arrowDown}
      </button>
    </div>
  );
}

// Grid thumbnail-size cycler (compact → comfortable → large).
function DensityControl({
  density,
  onChange,
}: {
  density: number;
  onChange: (d: number) => void;
}) {
  return (
    <button
      className="btn btn-sm btn-icon"
      onClick={() => onChange((density + 1) % GRID_SIZES.length)}
      title="Thumbnail size"
      aria-label="Cycle thumbnail size"
    >
      {Icons.gridSize}
    </button>
  );
}

// Derivative-status facet as count-bearing chips. Counts come from the shared
// /api/stats poll, so the facet doubles as an at-a-glance pipeline health read.
function StatusChips({
  status,
  onSelect,
}: {
  status: StatusKey;
  onSelect: (s: StatusKey) => void;
}) {
  const { stats } = useStats();
  const a = stats?.assets;
  const count: Record<StatusKey, number | undefined> = {
    all: a?.total,
    ready: a?.analyzed,
    pending: a?.pending,
    error: a?.errors,
    skipped: a?.skipped,
  };
  return (
    <div className="chips pl-status">
      {STATUS_ORDER.map((s) => (
        <button
          key={s}
          className={`chip${status === s ? " active" : ""}`}
          onClick={() => onSelect(s)}
          aria-pressed={status === s}
        >
          {STATUS_LABEL[s]}
          {count[s] != null && (
            <span className="chip-count">{count[s]!.toLocaleString()}</span>
          )}
        </button>
      ))}
    </div>
  );
}

// Folder view: a lazy, real-filesystem tree (like the Library's Browse tree)
// that expands one directory level at a time over /api/tree/fs, so hundreds of
// folders never load at once. Selecting a node scopes the grid (rendered as
// `children`) to that folder's whole subtree.
function FolderView({
  baseQuery,
  selected,
  onSelect,
  children,
}: {
  baseQuery: string;
  selected: string | null;
  onSelect: (path: string | null) => void;
  children: ReactNode;
}) {
  const [roots, setRoots] = useState<FsNode[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const suffix = baseQuery ? `&${baseQuery}` : "";

  useEffect(() => {
    let cancelled = false;
    setRoots(null);
    setErr(null);
    fetchJson<{ nodes: FsNode[] }>(
      `/api/tree/fs${baseQuery ? `?${baseQuery}` : ""}`,
    )
      .then((d) => !cancelled && setRoots(d.nodes))
      .catch((e: Error) => !cancelled && setErr(e.message));
    return () => {
      cancelled = true;
    };
  }, [baseQuery]);

  return (
    <div className="pl-folder">
      {err ? (
        <div className="error-box">
          <span>Couldn’t load folders: {err}</span>
        </div>
      ) : !roots ? (
        <div className="spinner">Loading…</div>
      ) : roots.length === 0 ? (
        <EmptyState icon={Icons.folder} title="No folders" />
      ) : (
        <div className="pl-fs-tree" role="tree" aria-label="Folders">
          {roots.map((n) => (
            <FsRow
              key={n.path}
              node={n}
              depth={0}
              suffix={suffix}
              selected={selected}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}

      {selected && (
        <div className="pl-fs-scope">
          <span className="pl-fs-scope-path" title={selected}>
            {Icons.folder} {selected}
          </span>
          <button
            className="btn btn-sm btn-icon"
            onClick={() => onSelect(null)}
            title="Clear folder scope"
            aria-label="Clear folder scope"
          >
            {Icons.close}
          </button>
        </div>
      )}

      {children}
    </div>
  );
}

// One directory row in the lazy tree. Clicking it selects the folder (scoping
// the grid) and, if it has subdirectories, expands them — fetched on first open.
function FsRow({
  node,
  depth,
  suffix,
  selected,
  onSelect,
}: {
  node: FsNode;
  depth: number;
  suffix: string;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<FsNode[] | null>(null);
  const [loading, setLoading] = useState(false);

  const onClick = async () => {
    onSelect(node.path);
    if (!node.expandable) return;
    if (children == null) {
      setLoading(true);
      try {
        const d = await fetchJson<{ nodes: FsNode[] }>(
          `/api/tree/fs?path=${encodeURIComponent(node.path)}${suffix}`,
        );
        setChildren(d.nodes);
      } catch {
        setChildren([]); // avoids a refetch loop on error
      } finally {
        setLoading(false);
      }
    }
    setOpen((o) => !o);
  };

  return (
    <div role="treeitem" aria-expanded={node.expandable ? open : undefined}>
      <button
        className={`tree-row${selected === node.path ? " active" : ""}`}
        style={{ paddingLeft: depth * 14 + 8 }}
        onClick={onClick}
        title={node.path}
      >
        <span className="tree-caret">
          {node.expandable ? (loading ? "…" : open ? "▾" : "▸") : ""}
        </span>
        <span className="pl-folder-icon">{Icons.folder}</span>
        <span className="tree-label">{node.name}</span>
        <span className="tree-count">{node.count.toLocaleString()}</span>
      </button>
      {open &&
        children?.map((c) => (
          <FsRow
            key={c.path}
            node={c}
            depth={depth + 1}
            suffix={suffix}
            selected={selected}
            onSelect={onSelect}
          />
        ))}
    </div>
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
              className="btn btn-icon"
              onClick={onView}
              title="Open the viewer"
              aria-label={`View ${asset.filename}`}
            >
              {Icons.view}
            </button>
          )}
          {actions.includes("download") && (
            <a
              className="btn btn-icon"
              href={`/api/assets/${asset.id}/download`}
              download
              title="Download the original file"
              aria-label={`Download ${asset.filename}`}
            >
              {Icons.download}
            </a>
          )}
          {(["regenerate", "skip", "delete"] as const)
            .filter((k) => actions.includes(k))
            .map((k) => {
              const m = MUTATIONS[k];
              return (
                <button
                  key={k}
                  className={`btn btn-icon${m.danger ? " btn-danger" : ""}`}
                  disabled={disabled || busy}
                  onClick={() => onRun(asset.id, k)}
                  title={m.label}
                  aria-label={`${m.label} ${asset.filename}`}
                >
                  {m.icon}
                </button>
              );
            })}
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
