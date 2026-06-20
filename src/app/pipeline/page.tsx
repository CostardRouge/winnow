import ControlPanel from "../ControlPanel";

// Dedicated pipeline page: the full counters bento + pause/resume + hourly rate
// sliders. Moved off the Library header (which now carries only a compact strip)
// so the controls have room to breathe and the triage views stay tall.
export default function PipelinePage() {
  return (
    <div className="app-shell">
      <div className="topbar">
        <h1>Pipeline</h1>
        <span className="hint">scan · analyze · queues</span>
      </div>
      <div className="pipeline-body">
        <ControlPanel />
      </div>
    </div>
  );
}
