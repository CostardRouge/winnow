"use client";

// Failures › Machine learning: assets whose ML analysis (faces/OCR/CLIP)
// errored. Each retry re-analyzes from the existing derivative — the original
// is never re-read.
import type { RowData } from "../model";
import { useFailures } from "../useFailures";
import { FamilyShell, RetrySection } from "../sections";

export default function MlFailuresPage() {
  const { data, error, busy, msg, load, doRetry } = useFailures();

  const rows: RowData<number>[] = (data?.ml.items ?? []).map((it) => ({
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
        title="Machine learning"
        hint="Assets whose ML analysis (face detection, OCR, CLIP embedding) failed — usually the ML container being unreachable, too old for a requested task, or timing out. Check the message, fix the container/models, then retry: each asset is re-analyzed from its existing derivative (the original is never re-read). Retry needs the ML feature on and a derivative to exist."
        count={data?.ml.count ?? 0}
        rows={rows}
        retryAllLabel="Retry all"
        prefix="ml"
        busy={busy}
        onRetry={(keys, busyKey) =>
          doRetry("ml", keys ? { ids: keys } : {}, busyKey)
        }
      />
    </FamilyShell>
  );
}
