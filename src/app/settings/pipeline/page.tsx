import ControlPanel from "../../ControlPanel";

// Settings › Pipeline — the pipeline control surface: the counters bento (each
// tile deep-links into its triage list under /pipeline), pause/resume, the
// hourly rate sliders and the maintenance backfills. Same component the
// /pipeline overview renders, so the two never drift.
export default function SettingsPipelinePage() {
  return <ControlPanel />;
}
