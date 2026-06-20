import ControlPanel from "../ControlPanel";

// Pipeline overview: the full counters bento + pause/resume + hourly rate
// sliders. The section chrome (heading + sub-route tabs) lives in layout.tsx;
// each counter links to its dedicated triage page.
export default function PipelinePage() {
  return <ControlPanel />;
}
