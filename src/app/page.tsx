"use client";

import { useState } from "react";
import Link from "next/link";
import ControlPanel from "./ControlPanel";
import IncomingTab from "./IncomingTab";
import ExportsTab from "./ExportsTab";
import GalleryShell from "./gallery/GalleryShell";

// Page d'accueil = hub à onglets, reflétant le workflow :
//   Incoming → à trier (sources NAS)   · Final → finalisé, consultation seule
//   Exports  → copies RAW pour Capture One (visualiser/supprimer)
// Le panneau de contrôle (pipeline) reste persistant au-dessus des onglets.

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
