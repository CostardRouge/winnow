"use client";

import { useState } from "react";
import Link from "next/link";
import ControlPanel from "./ControlPanel";
import IncomingTab from "./IncomingTab";
import ExportsTab from "./ExportsTab";
import GalleryShell from "./gallery/GalleryShell";

// Home page = tabbed hub, reflecting the workflow:
//   Incoming → to cull (NAS sources)   · Final → finalized, read-only view
//   Exports  → RAW copies for Capture One (view/delete)
// The control panel (pipeline) stays persistent above the tabs.

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
        <h1>🪶 Winnow</h1>
        <span className="hint">media triage — NAS</span>
        <span className="spacer" />
        <Link href="/failures" className="btn">
          Failures
        </Link>
        <Link href="/import" className="btn">
          + Import
        </Link>
      </div>

      <div className="shell-head">
        <ControlPanel />
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
      </div>

      <div className="tab-body">
        {tab === "incoming" && <IncomingTab />}
        {tab === "final" && <GalleryShell scope="final" />}
        {tab === "exports" && <ExportsTab />}
      </div>
    </div>
  );
}
