"use client";

import { useState } from "react";
import Link from "next/link";
import StatsStrip from "./StatsStrip";
import IncomingTab from "./IncomingTab";
import ExportsTab from "./ExportsTab";
import GalleryShell from "./gallery/GalleryShell";
import { Icons } from "./ui";

// Home page = tabbed hub, reflecting the workflow:
//   Incoming → to cull (NAS sources)   · Final → finalized, read-only view
//   Exports  → RAW copies for Capture One (view/delete)
// A compact stats strip rides the tabs row; the full pipeline control panel
// lives on its own /pipeline page (reached from the rail or a counter).

type Tab = "incoming" | "final" | "exports";

const TABS: { id: Tab; label: string }[] = [
  { id: "incoming", label: "Incoming" },
  { id: "final", label: "Final" },
  { id: "exports", label: "Exports" },
];

export default function Dashboard() {
  const [tab, setTab] = useState<Tab>("incoming");

  return (
    <div className="app-shell">
      <div className="topbar">
        <h1>Library</h1>
        <span className="hint max-sm:hidden">media triage — NAS</span>
        <span className="spacer" />
        <Link href="/volumes" className="btn">
          {Icons.folderPlus} Add folder
        </Link>
        <Link href="/import" className="btn btn-primary">
          {Icons.upload} Import
        </Link>
      </div>

      <div className="shell-head">
        <div className="shell-head-row">
          <div className="tabs">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={`tab${tab === t.id ? " active" : ""}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <span className="spacer" />
          <StatsStrip />
        </div>
      </div>

      <div className="tab-body">
        {tab === "incoming" && <IncomingTab />}
        {tab === "final" && <GalleryShell scope="final" />}
        {tab === "exports" && <ExportsTab />}
      </div>
    </div>
  );
}
