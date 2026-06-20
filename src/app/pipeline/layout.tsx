import PipelineNav from "./PipelineNav";

// Shared chrome for the Pipeline section: the heading, the sub-route tab bar
// (Overview / Media / Scanning / Pending / Analyzed / Failures) and a padded,
// scrollable body. Each sub-page only renders its own content.
export default function PipelineLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="app-shell">
      <div className="topbar">
        <h1>Pipeline</h1>
        <span className="hint">scan · analyze · queues</span>
      </div>
      <PipelineNav />
      <div className="pipeline-body">{children}</div>
    </div>
  );
}
