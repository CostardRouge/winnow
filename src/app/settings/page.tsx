import ControlPanel from "../ControlPanel";
import VolumesPanel from "../volumes/VolumesPanel";
import { Icons } from "@/app/ui";

// Settings page: central hub for pipeline, volumes, and import configuration.
// Displays control panel, volumes, and import information in organized sections.
export default function SettingsPage() {
  return (
    <div className="app-shell">
      <div className="topbar">
        <h1>Settings</h1>
        <span className="hint">pipeline, volumes, and import management</span>
      </div>

      <div className="pipeline-body">
        <div className="settings-container">
          {/* Pipeline section */}
          <section className="settings-section">
            <div className="settings-section-head">
              <span className="settings-section-ic" aria-hidden>
                {Icons.pipeline}
              </span>
              <h2>Pipeline</h2>
            </div>
            <p className="settings-section-desc">
              Control media processing queue, rate limiting, and indexing operations.
            </p>
            <div className="settings-section-body">
              <ControlPanel />
            </div>
          </section>

          {/* Volumes section */}
          <section className="settings-section">
            <div className="settings-section-head">
              <span className="settings-section-ic" aria-hidden>
                {Icons.volumes}
              </span>
              <h2>Volumes</h2>
            </div>
            <p className="settings-section-desc">
              Manage directories attached to the project for indexing and imports.
            </p>
            <div className="settings-section-body">
              <VolumesPanel />
            </div>
          </section>

          {/* Import section */}
          <section className="settings-section">
            <div className="settings-section-head">
              <span className="settings-section-ic" aria-hidden>
                {Icons.inbox}
              </span>
              <h2>Import</h2>
            </div>
            <p className="settings-section-desc">
              Bring media in — uploads, cards, drops, and server-mounted sources.
            </p>
            <div className="settings-section-body">
              <p className="settings-section-link">
                Go to the <a href="/import">Import page</a> to upload media.
              </p>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
