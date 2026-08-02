import VolumesPanel from "./VolumesPanel";

// Settings › Volumes — the registry of every directory attached to the project
// (the env-seeded incoming/finals/export plus anything added by hand), each with
// its type and indexing counts. This is where folders are added for indexing.
// Owns its own padded, scrollable body (the layout above supplies none).
export default function SettingsVolumesPage() {
  return (
    <div className="pipeline-body">
      <VolumesPanel />
    </div>
  );
}
