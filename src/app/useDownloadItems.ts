"use client";

// The three ways to pull a set of files out of the browser, as menu items —
//   · Download as ZIP        → a single server-streamed archive
//   · Download each file      → one staggered download per file
//   · Save to folder…         → write straight to a directory (File System Access)
// Built here, once, so the same list serves the labelled "Download ▾" button
// (DownloadMenu) and can be spliced into a row's ⋯ menu (SessionMenu) without
// nesting one menu inside another.
//
// The *source* is injected so one implementation drives every surface: an
// export downloads its copied output, a session downloads its originals. The
// caller passes the ZIP url and a lazy `listFiles` (resolved only when an action
// that needs the per-file list runs), so nothing is fetched just to render a
// button. Transient status ("Saving… 3/12") is surfaced through `onMessage`.
import { useCallback, useState } from "react";
import type { MenuItem } from "./ActionMenu";
import { Icons } from "./ui";
import type { DownloadFile } from "@/lib/assetActions";

export type DownloadSource = {
  /** URL streaming the whole selection as one ZIP. */
  zipHref: string;
  /** Suggested filename for the ZIP (the server sets the authoritative name). */
  zipName: string;
  /** Lazily resolve the per-file list (only the each/save actions need it). */
  listFiles: () => Promise<DownloadFile[]>;
  /** Surface transient status ("Started 8 downloads", "Save failed: …"). */
  onMessage?: (msg: string | null) => void;
};

// Minimal typing for the File System Access API (Chromium). Lets us save files
// straight into a folder the user picks instead of the browser's download tray.
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

/**
 * `source` may be undefined so a caller with nothing to download (a session
 * card without a download slot) can still call the hook unconditionally; it
 * then gets no items. `busy` is true while a per-file action runs.
 */
export function useDownloadItems(source: DownloadSource | undefined): {
  items: MenuItem[];
  busy: boolean;
} {
  const [busy, setBusy] = useState(false);
  const onMessage = source?.onMessage;
  const listFiles = source?.listFiles;
  const zipHref = source?.zipHref;
  const zipName = source?.zipName;
  const say = useCallback((m: string | null) => onMessage?.(m), [onMessage]);

  // One .zip of everything (server-streamed).
  const downloadZip = useCallback(() => {
    if (zipHref) triggerDownload(zipHref, zipName);
  }, [zipHref, zipName]);

  // Each file as its own download (the browser asks once to allow several).
  const downloadEach = useCallback(async () => {
    if (!listFiles) return;
    setBusy(true);
    say(null);
    try {
      const list = await listFiles();
      if (!list.length) {
        say("No downloadable files.");
        return;
      }
      for (let i = 0; i < list.length; i++) {
        triggerDownload(list[i].href, list[i].filename);
        // Stagger so the browser doesn't drop rapid-fire downloads.
        if (i < list.length - 1) await new Promise((r) => setTimeout(r, 350));
      }
      say(`Started ${list.length} download${list.length > 1 ? "s" : ""}.`);
    } catch (e) {
      say((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [listFiles, say]);

  // Save straight into a folder the user picks (File System Access API).
  const saveToFolder = useCallback(async () => {
    if (!listFiles) return;
    const picker = (window as DirPickerWindow).showDirectoryPicker;
    if (!picker) return;
    let dir: FsDirHandle;
    try {
      dir = await picker({ mode: "readwrite", id: "winnow-download" });
    } catch {
      return; // user dismissed the picker
    }
    setBusy(true);
    say(null);
    try {
      const list = await listFiles();
      const seen = new Map<string, number>();
      let saved = 0;
      for (const it of list) {
        const res = await fetch(it.href);
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
        say(`Saving… ${saved}/${list.length}`);
      }
      say(`Saved ${saved} file${saved !== 1 ? "s" : ""} to the folder.`);
    } catch (e) {
      say(`Save failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [listFiles, say]);

  if (!source) return { items: [], busy: false };

  const canSaveToFolder =
    typeof window !== "undefined" && "showDirectoryPicker" in window;

  const items: MenuItem[] = [
    {
      key: "zip",
      label: "Download as ZIP",
      hint: "One .zip archive",
      icon: Icons.archive,
      disabled: busy,
      onSelect: downloadZip,
    },
    {
      key: "each",
      label: "Download each file",
      hint: "Separate downloads",
      icon: Icons.download,
      disabled: busy,
      onSelect: () => void downloadEach(),
    },
    ...(canSaveToFolder
      ? [
          {
            key: "folder",
            label: "Save to folder…",
            hint: "Pick a destination on disk",
            icon: Icons.folder,
            disabled: busy,
            onSelect: () => void saveToFolder(),
          } as MenuItem,
        ]
      : []),
  ];
  return { items, busy };
}
