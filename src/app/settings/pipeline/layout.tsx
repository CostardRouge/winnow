import PipelineNav from "./PipelineNav";

// Nested chrome for Settings › Pipeline: the Overview / Media / Scanning /
// Pending / Failures sub-nav sits in the toolbar band directly under the
// Settings header (Pipeline / Volumes / Import), the same way Library nests its
// Sessions/Grid/Calendar/Map switcher under its own header — a fixed band
// above its own padded, scrolling body, so the sub-nav never scrolls out of
// view.
export default function SettingsPipelineLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="tab-body">
      <div className="page-tools">
        <PipelineNav />
      </div>
      <div className="pipeline-body">{children}</div>
    </div>
  );
}
