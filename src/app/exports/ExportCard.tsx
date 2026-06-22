"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { fetchJson } from "@/lib/fetchJson";
import { formatBytes, formatDimensions, formatDuration } from "@/lib/format";
import type { DownloadFile } from "@/lib/assetActions";
import { LazyImage, Icons } from "../ui";
import ThumbStrip, { type StripItem } from "../ThumbStrip";
import MediaViewer, { type ViewerItem } from "../MediaViewer";
import ExportActions from "./ExportActions";

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

// "50mm · f/2.8 · 1/200s · ISO 400" — the exposure triangle, blanks dropped.
function exposureLine(it: ExportItem): string | null {
  const parts = [
    it.focal_length ? `${it.focal_length}mm` : null,
    it.aperture ? `f/${it.aperture}` : null,
    it.shutter ? `${it.shutter}s` : null,
    it.iso ? `ISO ${it.iso}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

// The single descriptive line shown under each filename in the detailed list:
// resolution, camera, exposure (and duration for video). Missing bits are
// skipped so the line stays tight.
function detailMeta(it: ExportItem): string {
  const camera = [it.camera_model, it.lens].filter(Boolean).join(" · ");
  return [
    formatDimensions(it.width, it.height),
    it.media_type === "video" && it.duration_s != null
      ? formatDuration(it.duration_s)
      : null,
    camera || null,
    exposureLine(it),
  ]
    .filter(Boolean)
    .join("  ·  ");
}

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
  const [items, setItems] = useState<ExportItem[] | null>(null);
  const [itemsError, setItemsError] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
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

  // --- Downloads -----------------------------------------------------------
  const [dlMsg, setDlMsg] = useState<string | null>(null);
  // Auto-clear the transient download status.
  useEffect(() => {
    if (!dlMsg) return;
    const t = setTimeout(() => setDlMsg(null), 4000);
    return () => clearTimeout(t);
  }, [dlMsg]);

  // The file list may not have loaded yet when an action runs (e.g. the menu is
  // clicked before the card's lazy fetch). Fetch on demand if needed.
  const ensureItems = useCallback(async (): Promise<ExportItem[]> => {
    if (items) return items;
    const d = await fetchJson<{ items?: ExportItem[] }>(
      `/api/exports/${job.id}/items`,
    );
    const list = d.items ?? [];
    loadedRef.current = true;
    setItems(list);
    setItemsError(false);
    return list;
  }, [items, job.id]);

  const count = items?.length ?? job.export_count;

  const fileUrl = (it: ExportItem) =>
    `/api/exports/${job.id}/items/${it.id}`;

  // The DownloadMenu's per-file source: the export's copied output, one
  // /items/:id endpoint per downloadable file (skipping any whose copy is gone).
  const listDownloadFiles = useCallback(async (): Promise<DownloadFile[]> => {
    const list = (await ensureItems()).filter((it) => it.downloadable);
    return list.map((it) => ({
      filename: it.filename,
      href: `/api/exports/${job.id}/items/${it.id}`,
    }));
  }, [ensureItems, job.id]);

  // Map the export's files onto the shared strip's tile shape: a ready
  // derivative carries a thumbnail (and a per-file download href); everything
  // else falls back to a placeholder.
  const stripItems: StripItem[] | null =
    items?.map((it) => ({
      key: it.id,
      thumbSrc:
        it.derivative_status === "ready"
          ? `/api/assets/${it.source_asset_id}/thumb`
          : undefined,
      ext: it.ext,
      isVideo: it.media_type === "video",
      pending: it.derivative_status !== "ready",
      downloadHref: it.downloadable ? fileUrl(it) : undefined,
      title: it.filename,
    })) ?? null;

  // One row of the detailed manifest: a small thumbnail (opens the viewer),
  // the filename, a single descriptive metadata line, the file size and a
  // per-file download link.
  const detailRow = (it: ExportItem, idx: number) => {
    const meta = detailMeta(it);
    return (
      <li key={it.id} className="export-detail-row">
        <div
          className="export-detail-thumb"
          role="button"
          tabIndex={0}
          onClick={() => setViewerIndex(idx)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setViewerIndex(idx);
            }
          }}
          title={it.filename}
        >
          {it.derivative_status === "ready" ? (
            <LazyImage
              src={`/api/assets/${it.source_asset_id}/thumb`}
              alt={it.filename}
            />
          ) : (
            <span className="thumb-tile-ph">
              {it.media_type === "video" ? "🎬" : "⏳"}
            </span>
          )}
        </div>
        <div className="export-detail-info">
          <div className="export-detail-name" title={it.filename}>
            {it.filename}
            {it.ext && (
              <span className="export-detail-ext">
                {it.ext.replace(".", "").toUpperCase()}
              </span>
            )}
          </div>
          {meta && <div className="export-detail-meta">{meta}</div>}
        </div>
        <div className="export-detail-aside">
          {it.file_size != null && (
            <span className="export-detail-size">
              {formatBytes(it.file_size)}
            </span>
          )}
          {it.downloadable && (
            <a
              className="export-detail-dl"
              href={fileUrl(it)}
              download
              title={`Download ${it.filename}`}
              aria-label={`Download ${it.filename}`}
            >
              {Icons.download}
            </a>
          )}
        </div>
      </li>
    );
  };

  return (
    <div ref={cardRef} className="session-card export-card">
      <div className="card-head">
        <div className="card-info">
          <h3>{job.name}</h3>
          <div className="meta">
            {job.target} · {fmtDate(job.created_at)} · {count} files
            {job.result?.copied != null
              ? ` · ${job.result.copied}/${job.result.total ?? job.export_count} copied`
              : ""}
            {job.result?.error ? ` · ${job.result.error}` : ""}
          </div>
        </div>
        <div className="card-side">
          <ExportActions
            zipHref={`/api/exports/${job.id}/download`}
            zipName={`${job.name}.zip`}
            listFiles={listDownloadFiles}
            canDownload={count > 0}
            onMessage={setDlMsg}
            onDelete={del}
            deleteBusy={busy}
          />
          <span className={`pill ${statusPill(job.status)}`}>{job.status}</span>
          {dlMsg && <span className="hint export-dl-msg">{dlMsg}</span>}
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
              {/* A detailed manifest of exactly what will be / was copied:
                  filename, size, resolution, camera and exposure per file. Far
                  more useful than enlarging the thumbnails (which revealed
                  nothing new). */}
              <ul className="export-detail-list">
                {items?.map((it, idx) => detailRow(it, idx))}
              </ul>
              <button
                className="chip export-toggle"
                onClick={() => setExpanded(false)}
              >
                {Icons.arrowUp} Hide details
              </button>
            </>
          ) : (
            <>
              {/* The thumbnails open the viewer; clicking the "+N" tile or the
                  empty strip area opens the detailed list. A "Details" button
                  below keeps that reachable for keyboard users. */}
              <ThumbStrip
                items={stripItems}
                total={count}
                onItemActivate={(idx) => setViewerIndex(idx)}
                onOverflowActivate={() => items && setExpanded(true)}
              />
              {items != null && items.length > 0 && (
                <button
                  className="chip export-toggle"
                  onClick={() => setExpanded(true)}
                >
                  {Icons.viewList} Details ({count})
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
