import SettingsNav from "./SettingsNav";

// Shared chrome for the Settings section: the heading, the sub-route tab bar
// (Pipeline / Volumes / Import) and a padded, scrollable body. Each sub-page
// only renders its own pane. Reached from the account popover in the rail —
// deliberately not a rail entry of its own, so the rail stays about the work
// (Library, Sift, search, gear) and configuration lives one level down.
export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="app-shell">
      <div className="topbar">
        <h1>Settings</h1>
        <span className="hint max-sm:hidden">
          pipeline · volumes · import
        </span>
      </div>
      <SettingsNav />
      <div className="pipeline-body">{children}</div>
    </div>
  );
}
