import VolumesPanel from "../../volumes/VolumesPanel";

// Settings › Volumes — the registry of every directory attached to the project
// (the env-seeded incoming/finals/export plus anything added by hand), each with
// its type and indexing counts. This is where folders are added for indexing.
export default function SettingsVolumesPage() {
  return <VolumesPanel />;
}
