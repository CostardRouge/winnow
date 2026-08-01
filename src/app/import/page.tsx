import ImportPanel from "./ImportPanel";

// Standalone Import route — kept alongside the Settings › Import tab because the
// PWA manifest points a home-screen shortcut here and it's the one page a phone
// reaches for directly after a shoot. Both render the same ImportPanel.
export default function ImportPage() {
  return (
    <div className="app-shell">
      <div className="topbar">
        <h1>Import</h1>
        <span className="hint max-sm:hidden">
          bring media in — uploads, cards &amp; drops
        </span>
      </div>
      <div className="pipeline-body">
        <ImportPanel />
      </div>
    </div>
  );
}
