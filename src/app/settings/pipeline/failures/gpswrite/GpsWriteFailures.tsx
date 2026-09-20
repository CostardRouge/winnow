"use client";

// Failures › GPS write: assets whose write-back of a manually/bulk-set GPS
// coordinate into the ORIGINAL file's EXIF failed (cf. lib/exifWrite.ts). Each
// retry re-reads the asset's current coordinates and writes them again — a
// read-only mount or an unwritable format will keep failing until fixed.
import type { RowData } from "../model";
import { useFailures } from "../useFailures";
import { FamilyShell, RetrySection } from "../sections";

export default function GpsWriteFailuresPage() {
  const { data, error, busy, msg, load, doRetry } = useFailures();

  const rows: RowData<number>[] = (data?.gpsWrite.items ?? []).map((it) => ({
    key: it.asset_id,
    title: `#${it.asset_id} · ${it.filename} (${it.media_type})`,
    path: it.abs_path,
    error: it.error ?? "—",
    when: it.updated_at,
    downloadHref: `/api/assets/${it.asset_id}/download`,
  }));

  return (
    <FamilyShell onRefresh={load} error={error} msg={msg}>
      <RetrySection<number>
        title="GPS write"
        hint="Assets whose manually/bulk-set GPS coordinates failed to write back into the ORIGINAL file's EXIF — usually a read-only mount, an unwritable format, or a corrupted original. Check the message, fix the underlying issue, then retry: each asset's current coordinates are re-read and written again."
        count={data?.gpsWrite.count ?? 0}
        rows={rows}
        retryAllLabel="Retry all"
        prefix="gpswrite"
        busy={busy}
        onRetry={(keys, busyKey) =>
          doRetry("gpswrite", keys ? { ids: keys } : {}, busyKey)
        }
      />
    </FamilyShell>
  );
}
