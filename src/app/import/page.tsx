"use client";

// Import — the one place media enters Winnow. Four sources, in order of how
// often they're reached for: a big drag-and-drop zone for files OR a whole
// folder / SD-card tree (the phone picker and the desktop "upload the card"
// flow share it), a path field for a card mounted on the server, and a note
// about the always-on watched share. Whatever the source, the server dedupes
// and files everything by date & device; originals are never modified.
//
// Folder uploads keep their directory structure (webkitRelativePath / dropped
// directory entries → the "paths" field on /api/upload), so a clip and its
// sidecars (Sony XML/THM, DJI SRT) stay together and same-named files in
// different card folders don't collide.

import { useCallback, useRef, useState } from "react";
import { Icons } from "@/app/ui";

type BatchStatus = {
  id: number;
  origin: string;
  status: string;
  imported: number;
  duplicates: number;
  failed: number;
};

type UploadItem = { file: File; relPath: string };

// A representative slice of the accepted formats — shown under the drop zone so
// it's clear RAW, HEIC and the common video containers are all welcome.
const FORMAT_HINT = "ARW · DNG · NEF · CR3 · HEIC · JPG · PNG · MP4 · MOV · MKV";
const FILE_ACCEPT =
  "image/*,video/*,.arw,.dng,.nef,.cr2,.cr3,.raf,.rw2,.orf,.heic,.heif,.hif,.mp4,.mov,.mkv,.m4v,.avi,.xml,.thm,.srt";

// Skip OS cruft and hidden entries client-side so we don't waste the upload on
// bytes the server's import walk would ignore anyway (it prunes dot-entries).
function isJunk(relPath: string): boolean {
  return relPath
    .split("/")
    .some((seg) => seg.startsWith(".") || seg === "Thumbs.db" || seg === "@eaDir");
}

// FileList (from either picker) → items. A folder pick carries each file's
// webkitRelativePath ("card/DCIM/100MSDCF/C0001.MP4"); a loose file pick has
// none, so we fall back to the bare name.
function itemsFromFileList(list: FileList): UploadItem[] {
  return Array.from(list)
    .map((file) => ({
      file,
      relPath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
    }))
    .filter((it) => !isJunk(it.relPath));
}

// A dropped directory entry → its files, recursively, with the path rebuilt
// relative to the drop. readEntries yields in chunks, so we drain it until it
// returns empty. Best-effort: a read error on one branch just resolves it.
function walkEntry(
  entry: FileSystemEntry,
  prefix: string,
  out: UploadItem[],
): Promise<void> {
  return new Promise((resolve) => {
    if (entry.isFile) {
      (entry as FileSystemFileEntry).file(
        (file) => {
          out.push({ file, relPath: prefix + entry.name });
          resolve();
        },
        () => resolve(),
      );
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const dir = `${prefix}${entry.name}/`;
      const drain = () =>
        reader.readEntries(async (batch) => {
          if (!batch.length) return resolve();
          for (const child of batch) await walkEntry(child, dir, out);
          drain();
        }, () => resolve());
      drain();
    } else {
      resolve();
    }
  });
}

// A drop's DataTransfer → items. Prefers the entry API (preserves folders);
// falls back to the flat file list where it's unavailable.
async function itemsFromDrop(dt: DataTransfer): Promise<UploadItem[]> {
  const roots = Array.from(dt.items)
    .map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
    .filter((e): e is FileSystemEntry => e != null);
  if (roots.length === 0) {
    return Array.from(dt.files)
      .map((file) => ({ file, relPath: file.name }))
      .filter((it) => !isJunk(it.relPath));
  }
  const out: UploadItem[] = [];
  for (const entry of roots) await walkEntry(entry, "", out);
  return out.filter((it) => !isJunk(it.relPath));
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

export default function ImportPage() {
  const [progress, setProgress] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [offloadPath, setOffloadPath] = useState("");
  const [offloading, setOffloading] = useState(false);
  const [batch, setBatch] = useState<BatchStatus | null>(null);
  const [msg, setMsg] = useState<string>("");
  const [tone, setTone] = useState<"info" | "error">("info");
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  const say = useCallback((text: string, t: "info" | "error" = "info") => {
    setMsg(text);
    setTone(t);
  }, []);

  function pollBatch(id: number) {
    let errors = 0;
    const t = setInterval(async () => {
      try {
        const r = await fetch(`/api/import/${id}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        errors = 0;
        if (data.batch) {
          setBatch(data.batch);
          if (data.batch.status === "done" || data.batch.status === "error") {
            clearInterval(t);
            say(
              data.batch.status === "done"
                ? "Import finished."
                : "Import finished with errors.",
              data.batch.status === "done" ? "info" : "error",
            );
          }
        }
      } catch {
        // Tolerate a few network hiccups, then give up the polling.
        if (++errors >= 5) {
          clearInterval(t);
          say("Lost contact with the import job. Refresh to check status.", "error");
        }
      }
    }, 1500);
  }

  function upload(items: UploadItem[]) {
    if (items.length === 0) {
      say("Nothing to upload — that selection held no files.", "error");
      return;
    }
    const fd = new FormData();
    let bytes = 0;
    for (const it of items) {
      fd.append("files", it.file);
      fd.append("paths", it.relPath);
      bytes += it.file.size;
    }

    say(`Uploading ${items.length} file${items.length > 1 ? "s" : ""} · ${fmtBytes(bytes)}…`);
    setProgress(0);
    setBatch(null);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      setProgress(null);
      try {
        const data = JSON.parse(xhr.responseText);
        if (data.batch_id) {
          say("Uploaded — filing on the server…");
          pollBatch(data.batch_id);
        } else {
          say(`Error: ${data.error ?? xhr.statusText}`, "error");
        }
      } catch {
        say(`Error: ${xhr.statusText}`, "error");
      }
      if (fileInput.current) fileInput.current.value = "";
      if (folderInput.current) folderInput.current.value = "";
    };
    xhr.onerror = () => {
      setProgress(null);
      say("Upload failed.", "error");
    };
    xhr.send(fd);
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (progress != null) return;
    const items = await itemsFromDrop(e.dataTransfer);
    upload(items);
  }

  async function offload() {
    if (!offloadPath.trim()) return;
    setOffloading(true);
    say("Queuing card offload…");
    setBatch(null);
    try {
      const r = await fetch("/api/import/offload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: offloadPath.trim() }),
      });
      const data = await r.json();
      if (data.batch_id) {
        say("Offload queued — filing on the server…");
        pollBatch(data.batch_id);
      } else {
        say(`Error: ${data.error ?? "unknown"}`, "error");
      }
    } catch {
      say("Couldn’t reach the server to queue the offload.", "error");
    } finally {
      setOffloading(false);
    }
  }

  const busy = progress != null;

  return (
    <div className="app-shell">
      <div className="topbar">
        <h1>Import</h1>
        <span className="hint max-sm:hidden">bring media in — uploads, cards &amp; drops</span>
      </div>

      <div className="pipeline-body">
        <div className="import-page">
          {/* Primary: drag-and-drop / pick files / pick a whole folder or card. */}
          <section
            className={`import-drop${dragging ? " is-dragging" : ""}${busy ? " is-busy" : ""}`}
            onDragEnter={(e) => {
              e.preventDefault();
              dragDepth.current++;
              setDragging(true);
            }}
            onDragOver={(e) => e.preventDefault()}
            onDragLeave={(e) => {
              e.preventDefault();
              if (--dragDepth.current <= 0) {
                dragDepth.current = 0;
                setDragging(false);
              }
            }}
            onDrop={onDrop}
          >
            <span className="import-drop-ic" aria-hidden>
              {Icons.uploadCloud}
            </span>
            <h2>Drop media to import</h2>
            <p className="import-drop-sub">
              Photos, videos and their sidecars — or a whole folder / SD-card tree.
              Everything is deduplicated and filed by date &amp; device; your
              originals are never modified.
            </p>

            <div className="import-drop-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => fileInput.current?.click()}
                disabled={busy}
              >
                {Icons.upload} Choose files
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => folderInput.current?.click()}
                disabled={busy}
              >
                {Icons.folderPlus} Choose folder / SD card
              </button>
            </div>

            <p className="import-formats">{FORMAT_HINT}</p>

            <input
              ref={fileInput}
              type="file"
              multiple
              accept={FILE_ACCEPT}
              hidden
              onChange={(e) =>
                e.target.files && upload(itemsFromFileList(e.target.files))
              }
            />
            <input
              ref={(el) => {
                folderInput.current = el;
                if (el) {
                  // webkitdirectory isn't in the React typings — set it directly.
                  el.setAttribute("webkitdirectory", "");
                  el.setAttribute("directory", "");
                }
              }}
              type="file"
              multiple
              hidden
              onChange={(e) =>
                e.target.files && upload(itemsFromFileList(e.target.files))
              }
            />

            {busy && (
              <div className="import-progress">
                <div className="import-progress-track">
                  <div
                    className="import-progress-fill"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <span className="import-progress-pct">{progress}%</span>
              </div>
            )}
          </section>

          {/* Live status / result of the most recent job. */}
          {(msg || batch) && (
            <div className="import-status">
              {msg && (
                <p className={`import-msg${tone === "error" ? " is-error" : ""}`}>
                  {msg}
                </p>
              )}
              {batch && (
                <div className="import-batch">
                  <div className="import-batch-head">
                    <strong>Batch #{batch.id}</strong>
                    <span className="import-batch-origin">{batch.origin}</span>
                    <span className={`import-batch-state is-${batch.status}`}>
                      {batch.status}
                    </span>
                  </div>
                  <div className="counters">
                    <span className="pill ready">{batch.imported} imported</span>
                    <span className="pill">{batch.duplicates} duplicates</span>
                    {batch.failed > 0 && (
                      <span className="pill error">{batch.failed} failed</span>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Secondary sources: server-mounted card + the watched share. */}
          <div className="import-sources">
            <section className="import-source">
              <div className="import-source-head">
                <span className="import-source-ic" aria-hidden>
                  {Icons.hardDrive}
                </span>
                <h3>Card mounted on the server</h3>
              </div>
              <p className="hint">
                Offload an SD card inserted into the machine. Give its path as seen
                inside the container (e.g. <code>/media/card</code>); the card is
                read-only and left untouched.
              </p>
              <div className="import-offload">
                <input
                  className="input"
                  placeholder="/media/card"
                  value={offloadPath}
                  onChange={(e) => setOffloadPath(e.target.value)}
                  onKeyDown={(e) =>
                    e.key === "Enter" && !offloading && offloadPath.trim() && offload()
                  }
                />
                <button
                  className="btn btn-primary"
                  onClick={offload}
                  disabled={offloading || !offloadPath.trim()}
                >
                  {offloading ? "…" : "Offload"}
                </button>
              </div>
            </section>

            <section className="import-source">
              <div className="import-source-head">
                <span className="import-source-ic" aria-hidden>
                  {Icons.share}
                </span>
                <h3>SMB / FTP drop</h3>
              </div>
              <p className="hint">
                Drop files into the watched inbox share and they import
                automatically — deduped and filed the same way. Nothing to do here;
                this source runs on its own.
              </p>
              <div className="import-source-foot">
                <span className="import-watch-dot" aria-hidden />
                Watching the inbox share
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
