import VolumesPanel from "./VolumesPanel";

// Dedicated Volumes page: the registry of every directory attached to the
// project (the env-seeded incoming/finals/export plus anything added by hand),
// each with its type (Incoming / Final / Export) and indexing counts. This is
// where folders are added for indexing — replacing the old free-text field on
// the Library tab that made it too easy to scan "/".
export default function VolumesPage() {
  return (
    <div className="app-shell">
      <div className="topbar">
        <h1>Volumes</h1>
        <span className="hint">directories attached to the project</span>
      </div>
      <div className="pipeline-body">
        <VolumesPanel />
      </div>
    </div>
  );
}
