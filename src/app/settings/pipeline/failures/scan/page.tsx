"use client";

// Failures › Scan: files that couldn’t be indexed. Retry re-scans the affected
// roots, per item, by selection, or all at once.
import type { RowData } from "../model";
import { useFailures } from "../useFailures";
import { FamilyShell, RetrySection } from "../sections";

export default function ScanFailuresPage() {
  const { data, error, busy, msg, load, doRetry } = useFailures();

  const rows: RowData<string>[] = (data?.scan.items ?? []).map((it) => ({
    key: it.abs_path,
    title: it.abs_path,
    error: it.error,
    when: it.updated_at,
    badge: `${it.attempts}×`,
  }));

  return (
    <FamilyShell onRefresh={load} error={error} msg={msg}>
      <RetrySection<string>
        title="Scan (indexing)"
        hint="Files that couldn’t be indexed (unreadable, corrupt, metadata error). Retry re-scans the affected roots."
        count={data?.scan.count ?? 0}
        rows={rows}
        retryAllLabel="Retry all"
        prefix="scan"
        busy={busy}
        onRetry={(keys, busyKey) =>
          doRetry("scan", keys ? { paths: keys } : {}, busyKey)
        }
      />
    </FamilyShell>
  );
}
