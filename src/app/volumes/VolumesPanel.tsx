"use client";

// Volumes registry: a table of every directory attached to the project, each
// with its type (Incoming / Final / Export), session/media counts, and actions
// (re-index, remove). The "+ Add folder" button opens a modal where a type
// selector decides how the directory is interpreted — replacing the old
// free-text "index this path" field (which made it too easy to scan "/").
import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchJson } from "@/lib/fetchJson";
import { EmptyState, Icons } from "../ui";
import PullToRefresh from "../PullToRefresh";
import {
  VOLUME_TYPES,
  typeForKind,
  validateRootPath,
  type VolumeType,
} from "@/lib/volumes";
import type { Root } from "@/lib/types";

type RootRow = Root & { session_count: number; asset_count: number };
type RootsResponse = { roots?: RootRow[]; seeded?: string[] };

const TYPE_LABEL: Record<VolumeType | "inbox", string> = {
  incoming: "Incoming",
  final: "Final",
  export: "Export",
  inbox: "Inbox",
};

function fmtNum(n: number): string {
  return n.toLocaleString("en-GB");
}

export default function VolumesPanel() {
  const [roots, setRoots] = useState<RootRow[]>([]);
  const [seeded, setSeeded] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await fetchJson<RootsResponse>("/api/roots");
      setRoots(data.roots ?? []);
      setSeeded(data.seeded ?? []);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const seededSet = useMemo(() => new Set(seeded), [seeded]);

  async function changeType(r: RootRow, type: VolumeType) {
    setBusyId(r.id);
    try {
      await fetch(`/api/roots/${r.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type }),
      });
      await load();
    } finally {
      setBusyId(null);
    }
  }

  async function reindex(r: RootRow) {
    setBusyId(r.id);
    try {
      await fetch(`/api/roots/${r.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reindex: true }),
      });
      await load();
    } finally {
      setBusyId(null);
    }
  }

  async function remove(r: RootRow) {
    const ok = window.confirm(
      `Remove volume "${r.path}"?\n\nThis deletes its ${fmtNum(
        r.asset_count,
      )} indexed media + ${fmtNum(
        r.session_count,
      )} session(s) from the database. The files on the NAS are NOT touched (Winnow only ever reads them). You can re-add the folder later to re-index it.`,
    );
    if (!ok) return;
    setBusyId(r.id);
    try {
      await fetch(`/api/roots/${r.id}`, { method: "DELETE" });
      await load();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <PullToRefresh
      className="container"
      style={{ maxWidth: 1100, padding: 0 }}
      onRefresh={load}
    >
      <div className="filterbar">
        <p className="hint" style={{ margin: 0, flex: 1, minWidth: 200 }}>
          Every directory Winnow indexes or tracks. Pick a type per folder; the
          four env vars (incoming / finals / export) seed the defaults.
        </p>
        <button className="btn btn-primary" onClick={() => setAdding(true)}>
          {Icons.folderPlus} Add folder
        </button>
      </div>

      {error && (
        <div className="error-box">
          <span>Couldn’t load volumes: {error}</span>
          <button className="btn" onClick={load}>
            Retry
          </button>
        </div>
      )}

      {loading ? (
        <p className="hint">Loading volumes…</p>
      ) : roots.length === 0 ? (
        <EmptyState
          icon={Icons.volumes}
          title="No volumes registered yet"
          hint="Add a NAS folder to index, or configure INCOMING_DIR / FINALS_DIRS / EXPORT_DIR in the environment."
        >
          <button className="btn btn-primary" onClick={() => setAdding(true)}>
            {Icons.folderPlus} Add folder
          </button>
        </EmptyState>
      ) : (
        <div className="vol-table-wrap">
          <table className="vol-table">
            <thead>
              <tr>
                <th>Path</th>
                <th>Type</th>
                <th className="num">Sessions</th>
                <th className="num">Media</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {roots.map((r) => {
                const t = typeForKind(r.kind);
                const isInbox = t === "inbox";
                const walkable = r.kind === "source" || r.kind === "finals";
                const busy = busyId === r.id;
                return (
                  <tr key={r.id} className={busy ? "is-busy" : undefined}>
                    <td>
                      <div className="vol-path">{r.path}</div>
                      <div className="vol-tags">
                        <span className={`tag tag-${t}`}>{TYPE_LABEL[t]}</span>
                        <span className="tag tag-origin">
                          {seededSet.has(r.path) ? "env" : "manual"}
                        </span>
                        {walkable && !r.watch && (
                          <span className="tag tag-origin">no watch</span>
                        )}
                      </div>
                    </td>
                    <td>
                      {isInbox ? (
                        <span className="hint">inbox (internal)</span>
                      ) : (
                        <select
                          className="select"
                          value={t}
                          disabled={busy}
                          onChange={(e) =>
                            changeType(r, e.target.value as VolumeType)
                          }
                        >
                          {VOLUME_TYPES.map((vt) => (
                            <option key={vt.value} value={vt.value}>
                              {vt.label}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td className="num">{fmtNum(r.session_count)}</td>
                    <td className="num">{fmtNum(r.asset_count)}</td>
                    <td>
                      <div className="vol-actions">
                        {walkable && (
                          <button
                            className="btn btn-sm"
                            onClick={() => reindex(r)}
                            disabled={busy}
                            title="Re-enqueue an indexing scan for this volume"
                          >
                            Re-index
                          </button>
                        )}
                        <button
                          className="btn btn-sm btn-danger"
                          onClick={() => remove(r)}
                          disabled={busy}
                        >
                          Remove
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {adding && (
        <AddVolumeModal
          existing={roots}
          onClose={() => setAdding(false)}
          onAdded={async () => {
            setAdding(false);
            await load();
          }}
        />
      )}
    </PullToRefresh>
  );
}

type FsEntry = { name: string; path: string };
type FsListing = {
  path: string;
  parent: string | null;
  roots: string[];
  entries: FsEntry[];
};

// Server-side folder picker: browse the NAS (confined to the configured roots,
// cf. GET /api/fs) instead of typing a path. Navigating into a folder also
// selects it — the folder you're looking at is the one that gets registered.
function FolderPicker({
  value,
  onNavigate,
  existing,
}: {
  value: string;
  onNavigate: (p: string) => void;
  existing: { path: string }[];
}) {
  const [data, setData] = useState<FsListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    const sp = new URLSearchParams();
    if (value) sp.set("path", value);
    fetchJson<FsListing>(`/api/fs?${sp.toString()}`)
      .then((d) => {
        if (active) setData(d);
      })
      .catch((e) => {
        if (active) setError((e as Error).message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [value]);

  const existingSet = useMemo(
    () => new Set(existing.map((r) => r.path)),
    [existing],
  );

  const atRoot = value === "";
  const upTarget = data?.parent ?? "";

  return (
    <div className="picker">
      <div className="picker-bar">
        <button
          type="button"
          className="btn btn-sm"
          disabled={atRoot || loading}
          onClick={() => onNavigate(upTarget)}
          title="Up one level"
        >
          {Icons.back} Up
        </button>
        <span className="picker-cwd" title={value || "Locations"}>
          {value || "Locations"}
        </span>
      </div>

      {error ? (
        <div className="picker-msg picker-err">{error}</div>
      ) : loading && !data ? (
        <div className="picker-msg">Loading…</div>
      ) : data && data.entries.length === 0 ? (
        <div className="picker-msg">No subfolders here — select it below.</div>
      ) : (
        <ul className={`picker-list${loading ? " is-loading" : ""}`} aria-busy={loading}>
          {data?.entries.map((e) => (
            <li key={e.path}>
              <button
                type="button"
                className="picker-row"
                onClick={() => onNavigate(e.path)}
                title={e.path}
              >
                <span className="picker-ic">{Icons.folder}</span>
                <span className="picker-name">{atRoot ? e.path : e.name}</span>
                {existingSet.has(e.path) && (
                  <span className="tag tag-origin">added</span>
                )}
                <span className="picker-chev">{Icons.chevronRight}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Modal: a path + a type selector ("how to interpret this directory"), with the
// same guards the server enforces pre-checked client-side for instant feedback.
function AddVolumeModal({
  existing,
  onClose,
  onAdded,
}: {
  existing: { path: string }[];
  onClose: () => void;
  onAdded: () => void | Promise<void>;
}) {
  const [mode, setMode] = useState<"browse" | "manual">("browse");
  const [path, setPath] = useState("");
  const [type, setType] = useState<VolumeType>("incoming");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const guard = path.trim() ? validateRootPath(path, existing) : null;
  const blocked = !path.trim() || (guard !== null && !guard.ok);

  async function submit() {
    const check = validateRootPath(path, existing);
    if (!check.ok) {
      setError(check.reason);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/roots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: check.path, type }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setError(d.error ?? "Couldn’t register this folder.");
        return;
      }
      await onAdded();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="modal-overlay"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Add a volume"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title">Add a folder to index</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          Browse the NAS and pick a folder, then choose how Winnow should treat it.
        </p>

        <div
          className="view-toggle"
          role="group"
          aria-label="Add folder mode"
          style={{ marginTop: 4 }}
        >
          <button
            type="button"
            className={`view-btn${mode === "browse" ? " active" : ""}`}
            onClick={() => setMode("browse")}
            aria-pressed={mode === "browse"}
          >
            Browse
          </button>
          <button
            type="button"
            className={`view-btn${mode === "manual" ? " active" : ""}`}
            onClick={() => setMode("manual")}
            aria-pressed={mode === "manual"}
          >
            Enter path
          </button>
        </div>

        {mode === "browse" ? (
          <>
            <FolderPicker
              value={path}
              existing={existing}
              onNavigate={(p) => {
                setPath(p);
                setError(null);
              }}
            />
            <div className="picker-selected">
              {path ? (
                <>
                  Selected: <code>{path}</code>
                </>
              ) : (
                <span className="hint">No folder selected yet.</span>
              )}
            </div>
          </>
        ) : (
          <>
            <label className="modal-label" htmlFor="vol-path">
              Folder path
            </label>
            <input
              id="vol-path"
              className="input"
              style={{ width: "100%" }}
              placeholder="/nas/2026/voyage"
              value={path}
              autoFocus
              onChange={(e) => {
                setPath(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => e.key === "Enter" && !blocked && submit()}
            />
          </>
        )}

        <label className="modal-label">Type</label>
        <div className="type-choices">
          {VOLUME_TYPES.map((vt) => (
            <label
              key={vt.value}
              className={`type-choice${type === vt.value ? " active" : ""}`}
            >
              <input
                type="radio"
                name="vol-type"
                value={vt.value}
                checked={type === vt.value}
                onChange={() => setType(vt.value)}
              />
              <span className="type-choice-label">{vt.label}</span>
              <span className="type-choice-hint">{vt.hint}</span>
            </label>
          ))}
        </div>

        {guard && !guard.ok && !error && (
          <p className="modal-warn">{guard.reason}</p>
        )}
        {error && <p className="modal-warn">{error}</p>}

        <div className="modal-actions">
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={submit}
            disabled={busy || blocked}
          >
            {busy ? "…" : "Add volume"}
          </button>
        </div>
      </div>
    </div>
  );
}
