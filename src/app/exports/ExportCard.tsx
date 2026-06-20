"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { fetchJson } from "@/lib/fetchJson";
import { LazyImage, Icons } from "../ui";
import MediaViewer, { type ViewerItem } from "../MediaViewer";

// One export job rendered as a card. Beyond the summary + actions, the card can:
//   - download the whole export as a ZIP (header button);
//   - preview its files as a single responsive row of derivatives that shrinks
//     with the card width (a ResizeObserver decides how many fit);
//   - expand into a full grid of every file;
//   - open any derivative full-size in the shared MediaViewer, from where the
//     original can be downloaded individually.
// The file list is fetched lazily the first time the card scrolls into view.

export type ExportJob = {
  id: number;
  name: string;
  target: string;
  status: string;
  created_at: string;
  finished_at: string | null;
  result: {
    dest_dir?: string;
    total?: number;
    copied?: number;
    errors?: unknown[];
    error?: string;
  } | null;
  export_count: number;
  sample_asset_ids: number[];
};

// A file inside the export. `id` is the export row id (used for the per-file
// download); media/thumbnails are keyed by `source_asset_id` since the export
// reuses the source asset's derivatives.
type ExportItem = ViewerItem & {
  id: number;
  source_asset_id: number;
  filename: string;
  ext: string | null;
  media_type: "photo" | "video";
  derivative_status: string;
  downloadable: boolean;
};

const THUMB = 76; // strip thumbnail size (px)
const GAP = 6;

function fmtDate(s: string | null): string {
  if (!s) return "—";
  try {
    return new Date(s).toLocaleDateString("en-GB");
  } catch {
    return s;
  }
}

export default function ExportCard({
  job,
  onChanged,
}: {
  job: ExportJob;
  onChanged: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const [items, setItems] = useState<ExportItem[] | null>(null);
  const [itemsError, setItemsError] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [fit, setFit] = useState(8);
  const [busy, setBusy] = useState(false);
  const loadedRef = useRef(false);

  const load = useCallback(async () => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    try {
      const d = await fetchJson<{ items?: ExportItem[] }>(
        `/api/exports/${job.id}/items`,
      );
      setItems(d.items ?? []);
      setItemsError(false);
    } catch {
      setItems([]);
      setItemsError(true);
      loadedRef.current = false; // allow a retry on next interaction
    }
  }, [job.id]);

  // Fetch the file list once the card is (almost) on screen.
  useEffect(() => {
    const el = cardRef.current;
    if (!el || loadedRef.current) return;
    if (typeof IntersectionObserver === "undefined") {
      void load();
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          void load();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [load]);

  // How many derivatives fit on one line — recomputed as the card resizes.
  useEffect(() => {
    const el = stripRef.current;
    if (!el || expanded) return;
    const measure = (w: number) =>
      setFit(Math.max(1, Math.floor((w + GAP) / (THUMB + GAP))));
    measure(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      measure(entries[0].contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [expanded, items]);

  async function del() {
    if (
      !confirm(
        `Delete export “${job.name}”?\nThis removes the copied RAW files from the export folder and reverts these photos to 'triaged'.`,
      )
    )
      return;
    setBusy(true);
    try {
      await fetch(`/api/exports/${job.id}`, { method: "DELETE" });
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  const count = items?.length ?? job.export_count;
  const overflow = items != null && items.length > fit;
  const shown = overflow ? Math.max(1, fit - 1) : items?.length ?? 0;

  const fileUrl = (it: ExportItem) =>
    `/api/exports/${job.id}/items/${it.id}`;

  // A derivative tile. It's a div (not a button) so the per-file download <a>
  // can nest inside it as valid HTML; click/keyboard open the viewer.
  const tile = (it: ExportItem, idx: number, style?: CSSProperties) => (
    <div
      key={it.id}
      className="export-thumb"
      style={style}
      role="button"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        setViewerIndex(idx);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setViewerIndex(idx);
        }
      }}
      title={it.filename}
    >
      {it.derivative_status === "ready" ? (
        <LazyImage src={`/api/assets/${it.source_asset_id}/thumb`} alt={it.filename} />
      ) : (
        <span className="export-thumb-ph">
          {it.media_type === "video" ? "🎬" : "⏳"}
        </span>
      )}
      {it.media_type === "video" && it.derivative_status === "ready" && (
        <span className="play-badge">▶</span>
      )}
      {it.downloadable && (
        <a
          className="export-dl"
          href={fileUrl(it)}
          download
          onClick={(e) => e.stopPropagation()}
          title={`Download ${it.filename}`}
          aria-label={`Download ${it.filename}`}
        >
          {Icons.download}
        </a>
      )}
      <span className="ext-badge">{(it.ext ?? "").replace(".", "")}</span>
    </div>
  );

  return (
    <div ref={cardRef} className="session-card export-card">
      <div className="export-card-head">
        <div style={{ flex: 1, minWidth: 200 }}>
          <h3>{job.name}</h3>
          <div className="meta">
            {job.target} · {fmtDate(job.created_at)} · {count} files
            {job.result?.copied != null
              ? ` · ${job.result.copied}/${job.result.total ?? job.export_count} copied`
              : ""}
            {job.result?.error ? ` · ${job.result.error}` : ""}
          </div>
        </div>
        <div className="session-actions">
          <span className={`pill ${statusPill(job.status)}`}>{job.status}</span>
          {count > 0 && (
            <a
              className="btn"
              href={`/api/exports/${job.id}/download`}
              download
              title="Download every file as a ZIP"
            >
              {Icons.download} Download
            </a>
          )}
          <button className="btn btn-reject" disabled={busy} onClick={del}>
            {busy ? "…" : "Delete"}
          </button>
        </div>
      </div>

      {count > 0 && (
        <div className="export-body">
          {itemsError ? (
            <div className="error-box">
              <span>Couldn’t load the files.</span>
              <button className="btn" onClick={() => void load()}>
                Retry
              </button>
            </div>
          ) : expanded ? (
            <>
              <div className="export-grid">
                {items?.map((it, idx) => tile(it, idx))}
              </div>
              <button
                className="chip export-toggle"
                onClick={() => setExpanded(false)}
              >
                {Icons.arrowUp} Show less
              </button>
            </>
          ) : (
            <>
              {/* Clicking the empty strip area expands the card; the thumbnails
                  stop propagation to open the viewer instead. Keyboard users get
                  the explicit "Show all" button below. */}
              <div
                ref={stripRef}
                className="export-strip"
                onClick={() => items && setExpanded(true)}
                title="Show all files"
              >
                {items == null
                  ? Array.from({ length: Math.max(1, fit) }).map((_, i) => (
                      <span
                        key={i}
                        className="skeleton"
                        style={{
                          width: THUMB,
                          height: THUMB,
                          flex: "0 0 auto",
                        }}
                      />
                    ))
                  : items
                      .slice(0, shown)
                      .map((it, idx) =>
                        tile(it, idx, {
                          width: THUMB,
                          height: THUMB,
                          flexShrink: 0,
                        }),
                      )}
                {overflow && (
                  <span
                    className="export-thumb export-more"
                    style={{ width: THUMB, height: THUMB, flexShrink: 0 }}
                  >
                    +{count - shown}
                  </span>
                )}
              </div>
              {items != null && items.length > 1 && (
                <button
                  className="chip export-toggle"
                  onClick={() => setExpanded(true)}
                >
                  {Icons.arrowDown} Show all ({count})
                </button>
              )}
            </>
          )}
        </div>
      )}

      {viewerIndex != null && items && items[viewerIndex] && (
        <MediaViewer
          items={items}
          index={viewerIndex}
          onIndexChange={setViewerIndex}
          onClose={() => setViewerIndex(null)}
          mediaSrc={(it) => `/api/assets/${it.source_asset_id}/proxy`}
          posterSrc={(it) => `/api/assets/${it.source_asset_id}/thumb`}
          renderActions={(it) =>
            it.downloadable ? (
              <a className="btn" href={fileUrl(it)} download>
                {Icons.download} Download
              </a>
            ) : null
          }
        />
      )}
    </div>
  );
}

function statusPill(status: string): string {
  if (status === "done") return "ready";
  if (status === "error") return "error";
  return "pending";
}
