import type { Metadata } from "next";
import DatabasePanel from "./DatabasePanel";

export const metadata: Metadata = { title: "Database · Settings" };

// Settings › Database — what Postgres physically holds: per-table sizes with
// their heap/TOAST/index split, the exact weight of the embedding columns, and
// the backup story (download a fresh pg_dump, grab the sidecar's scheduled
// dumps). The "look before you migrate" page: check what you have, take a
// dump, run the risky work, compare. Owns its own padded, scrollable body.
export default function SettingsDatabasePage() {
  return (
    <div className="pipeline-body">
      <DatabasePanel />
    </div>
  );
}
