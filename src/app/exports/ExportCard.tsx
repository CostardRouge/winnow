"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { fetchJson } from "@/lib/fetchJson";
import { formatBytes, formatDimensions, formatDuration } from "@/lib/format";
import { LazyImage, Icons } from "../ui";
import MediaViewer, { type ViewerItem } from "../MediaViewer";
import ActionMenu, { type MenuItem } from "../ActionMenu";

// Minimal typing for the File System Access API (Chromium). Lets us save an
// export's files straight into a folder the user picks, instead of going through
// the browser's download tray.
type FsWritable = {
  write: (data: Blob | BufferSource) => Promise<void>;
  close: () => Promise<void>;
};
type FsFileHandle = { createWritable: () => Promise<FsWritable> };
type FsDirHandle = {
  getFileHandle: (
    name: string,
    opts?: { create?: boolean },
  ) => Promise<FsFileHandle>;
};
type DirPickerWindow = Window & {
  showDirectoryPicker?: (opts?: {
    mode?: "read" | "readwrite";
    id?: string;
  }) => Promise<FsDirHandle>;
};

// "IMG_1234.ARW" → "IMG_1234 (2).ARW" — disambiguate identical names on save.
function numberedName(filename: string, n: number): string {
  const dot = filename.lastIndexOf(".");
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : "";
  return `${base} (${n + 1})${ext}`;
}

function triggerDownload(href: string, filename?: string) {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename ?? "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

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

  // --- Downloads -----------------------------------------------------------
  const [dlMsg, setDlMsg] = useState<string | null>(null);
  const [dlBusy, setDlBusy] = useState(false);
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

  // One .zip of everything (server-streamed).
  const downloadZip = useCallback(() => {
    triggerDownload(`/api/exports/${job.id}/download`, `${job.name}.zip`);
  }, [job.id, job.name]);

  // Each original as its own download (the browser asks once to allow several).
  const downloadEach = useCallback(async () => {
    setDlBusy(true);
    setDlMsg(null);
    try {
      const list = (await ensureItems()).filter((it) => it.downloadable);
      if (!list.length) {
        setDlMsg("No downloadable files.");
        return;
      }
      for (let i = 0; i < list.length; i++) {
        triggerDownload(
          `/api/exports/${job.id}/items/${list[i].id}`,
          list[i].filename,
        );
        // Stagger so the browser doesn't drop rapid-fire downloads.
        if (i < list.length - 1) await new Promise((r) => setTimeout(r, 350));
      }
      setDlMsg(`Started ${list.length} download${list.length > 1 ? "s" : ""}.`);
    } catch (e) {
      setDlMsg((e as Error).message);
    } finally {
      setDlBusy(false);
    }
  }, [ensureItems, job.id]);

  // Save straight into a folder the user picks (File System Access API).
  const saveToFolder = useCallback(async () => {
    const picker = (window as DirPickerWindow).showDirectoryPicker;
    if (!picker) return;
    let dir: FsDirHandle;
    try {
      dir = await picker({ mode: "readwrite", id: "winnow-export" });
    } catch {
      return; // user dismissed the picker
    }
    setDlBusy(true);
    setDlMsg(null);
    try {
      const list = (await ensureItems()).filter((it) => it.downloadable);
      const seen = new Map<string, number>();
      let saved = 0;
      for (const it of list) {
        const res = await fetch(`/api/exports/${job.id}/items/${it.id}`);
        if (!res.ok) continue;
        const blob = await res.blob();
        const n = seen.get(it.filename) ?? 0;
        seen.set(it.filename, n + 1);
        const name = n === 0 ? it.filename : numberedName(it.filename, n);
        const handle = await dir.getFileHandle(name, { create: true });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        saved++;
        setDlMsg(`Saving… ${saved}/${list.length}`);
      }
      setDlMsg(`Saved ${saved} file${saved > 1 ? "s" : ""} to the folder.`);
    } catch (e) {
      setDlMsg(`Save failed: ${(e as Error).message}`);
    } finally {
      setDlBusy(false);
    }
  }, [ensureItems, job.id]);

  const canSaveToFolder =
    typeof window !== "undefined" && "showDirectoryPicker" in window;

  const downloadMenu: MenuItem[] = [
    {
      key: "zip",
      label: "Download as ZIP",
      hint: "One .zip archive",
      icon: Icons.archive,
      disabled: dlBusy,
      onSelect: downloadZip,
    },
    {
      key: "each",
      label: "Download each file",
      hint: "Separate downloads",
      icon: Icons.download,
      disabled: dlBusy,
      onSelect: () => void downloadEach(),
    },
    ...(canSaveToFolder
      ? [
          {
            key: "folder",
            label: "Save to folder…",
            hint: "Pick a destination on disk",
            icon: Icons.folder,
            disabled: dlBusy,
            onSelect: () => void saveToFolder(),
          } as MenuItem,
        ]
      : []),
  ];

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
            <span className="export-thumb-ph">
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
          {dlMsg && <span className="hint export-dl-msg">{dlMsg}</span>}
          <span className={`pill ${statusPill(job.status)}`}>{job.status}</span>
          {count > 0 && (
            <ActionMenu
              ariaLabel="Download options"
              label="Download"
              items={downloadMenu}
              disabled={dlBusy}
              trigger={{
                label: dlBusy ? "Downloading…" : "Download",
                icon: Icons.download,
                className: "btn",
              }}
            />
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
              {/* Clicking the empty strip area opens the detailed list; the
                  thumbnails stop propagation to open the viewer instead.
                  Keyboard users get the explicit "Details" button below. */}
              <div
                ref={stripRef}
                className="export-strip"
                onClick={() => items && setExpanded(true)}
                title="Show file details"
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
                    title={`${count - shown} more — open details`}
                  >
                    +{count - shown}
                  </span>
                )}
              </div>
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
