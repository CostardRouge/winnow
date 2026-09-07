import type { Metadata } from "next";
import FeaturesPanel from "./FeaturesPanel";

export const metadata: Metadata = { title: "Features · Settings" };

// Settings › Features — which optional sections of the app this instance
// offers (cf. src/lib/features.ts for why the flags live in the database and
// not in the environment). Owns its own padded, scrollable body (the layout
// above supplies none).
export default function SettingsFeaturesPage() {
  return (
    <div className="pipeline-body">
      <FeaturesPanel />
    </div>
  );
}
