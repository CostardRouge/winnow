import type { Metadata } from "next";
import ImportPanel from "./ImportPanel";

export const metadata: Metadata = { title: "Import · Settings" };

// Settings › Import — the four ingest sources (drop zone, file picker, folder /
// SD-card picker, a card mounted on the server, plus the always-on watched
// share). The PWA home-screen "Import" shortcut lands here too. Owns its own
// padded, scrollable body (the layout above supplies none).
export default function SettingsImportPage() {
  return (
    <div className="pipeline-body">
      <ImportPanel />
    </div>
  );
}
