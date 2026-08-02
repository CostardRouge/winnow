import SettingsNav from "./SettingsNav";

// Shared chrome for the Settings section: the heading and the sub-route tab
// bar (Pipeline / Volumes / Import / Database). The body itself carries no padding/scroll
// of its own — same as Library's .tab-body — so a section with its own nested
// sub-nav (Settings › Pipeline) can pin that nav above its own scrolling body
// instead of scrolling under this one. Plain sections (Volumes, Import) own
// their padded scroll area directly. Reached from the account popover in the
// rail — deliberately not a rail entry of its own, so the rail stays about the
// work (Library, Sift, search, gear) and configuration lives one level down.
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
          pipeline · volumes · import · database
        </span>
      </div>
      <div className="shell-head">
        <div className="shell-head-row">
          <SettingsNav />
        </div>
      </div>
      <div className="tab-body">{children}</div>
    </div>
  );
}
