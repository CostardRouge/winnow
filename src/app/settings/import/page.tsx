import ImportPanel from "../../import/ImportPanel";

// Settings › Import — the four ingest sources (drop zone, file picker, folder /
// SD-card picker, a card mounted on the server, plus the always-on watched
// share). Same panel the standalone /import route renders.
export default function SettingsImportPage() {
  return <ImportPanel />;
}
