import PipelineNav from "./PipelineNav";

// Nested chrome for Settings › Pipeline: the Overview / Media / Scanning /
// Pending / Failures sub-nav sits directly under the Settings tabs (Pipeline /
// Volumes / Import), the same way Library nests its Sessions/Grid/Calendar/Map
// switcher under Incoming/Gallery/Exports/Trash — a fixed nav row above its
// own padded, scrolling body, so the sub-nav never scrolls out of view.
export default function SettingsPipelineLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="tab-body">
      <div className="shell-head">
        <div className="shell-head-row">
          <PipelineNav />
        </div>
      </div>
      <div className="pipeline-body">{children}</div>
    </div>
  );
}
