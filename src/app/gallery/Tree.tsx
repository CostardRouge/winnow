"use client";

import { useEffect, useState } from "react";
import { fetchJson } from "@/lib/fetchJson";

export type TreeNodeData = {
  key: string;
  value: string | number;
  label: string;
  count: number;
  leaf: boolean;
};
export type PathSeg = { key: string; value: string | number; label: string };

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function nodeLabel(n: TreeNodeData): string {
  return n.key === "month" ? (MONTHS[Number(n.value) - 1] ?? n.label) : n.label;
}

function pathKey(path: PathSeg[]): string {
  return path.map((s) => `${s.key}:${s.value}`).join("/");
}

async function fetchChildren(
  group: string,
  path: PathSeg[],
): Promise<TreeNodeData[]> {
  const sp = new URLSearchParams({ group });
  for (const s of path) sp.set(s.key, String(s.value));
  const d = await fetchJson<{ nodes?: TreeNodeData[] }>(
    `/api/tree?${sp.toString()}`,
  );
  return d.nodes ?? [];
}

function Node({
  group,
  parent,
  node,
  depth,
  activeKey,
  onScope,
}: {
  group: string;
  parent: PathSeg[];
  node: TreeNodeData;
  depth: number;
  activeKey: string;
  onScope: (path: PathSeg[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<TreeNodeData[] | null>(null);
  const myPath: PathSeg[] = [
    ...parent,
    { key: node.key, value: node.value, label: nodeLabel(node) },
  ];
  const myKey = pathKey(myPath);

  async function onClick() {
    onScope(myPath);
    if (node.leaf) return;
    if (children == null) {
      try {
        setChildren(await fetchChildren(group, myPath));
      } catch {
        setChildren([]); // évite une boucle de rechargement sur erreur
      }
    }
    setOpen((o) => !o);
  }

  return (
    <div>
      <button
        className={`tree-row${activeKey === myKey ? " active" : ""}`}
        style={{ paddingLeft: depth * 14 + 8 }}
        onClick={onClick}
      >
        <span className="tree-caret">{node.leaf ? "" : open ? "▾" : "▸"}</span>
        <span className="tree-label">{nodeLabel(node)}</span>
        <span className="tree-count">{node.count}</span>
      </button>
      {open &&
        children?.map((c) => (
          <Node
            key={`${c.key}:${c.value}`}
            group={group}
            parent={myPath}
            node={c}
            depth={depth + 1}
            activeKey={activeKey}
            onScope={onScope}
          />
        ))}
    </div>
  );
}

export default function Tree({
  activeKey,
  onScope,
}: {
  activeKey: string;
  onScope: (path: PathSeg[]) => void;
}) {
  const [group, setGroup] = useState<"date" | "folder" | "device">("date");
  const [roots, setRoots] = useState<TreeNodeData[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRoots(null);
    setError(null);
    fetchChildren(group, [])
      .then((n) => !cancelled && setRoots(n))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [group]);

  return (
    <div>
      <div className="chips" style={{ marginBottom: 10 }}>
        {(["date", "folder", "device"] as const).map((g) => (
          <button
            key={g}
            className={`chip${group === g ? " active" : ""}`}
            onClick={() => setGroup(g)}
          >
            {g === "date" ? "Date" : g === "folder" ? "Folder" : "Device"}
          </button>
        ))}
      </div>
      <button
        className="btn"
        style={{ width: "100%", marginBottom: 8 }}
        onClick={() => onScope([])}
      >
        ↺ All (clear scope)
      </button>
      {error ? (
        <div className="hint">Couldn’t load tree: {error}</div>
      ) : !roots ? (
        <div className="spinner">Loading…</div>
      ) : roots.length === 0 ? (
        <div className="hint">Nothing here.</div>
      ) : (
        roots.map((n) => (
          <Node
            key={`${n.key}:${n.value}`}
            group={group}
            parent={[]}
            node={n}
            depth={0}
            activeKey={activeKey}
            onScope={onScope}
          />
        ))
      )}
    </div>
  );
}
