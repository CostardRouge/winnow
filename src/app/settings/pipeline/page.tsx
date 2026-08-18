import type { Metadata } from "next";
import ControlPanel from "../../ControlPanel";

export const metadata: Metadata = { title: "Pipeline · Settings" };

// Settings › Pipeline — the pipeline control surface: the counters bento (each
// tile deep-links into its triage list, e.g. /settings/pipeline/media),
// pause/resume, the hourly rate sliders and the maintenance backfills.
export default function SettingsPipelinePage() {
  return <ControlPanel />;
}
