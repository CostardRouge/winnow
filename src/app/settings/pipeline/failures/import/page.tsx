"use client";

// Failures › Import: files that failed verification/filing. They are
// quarantined in the inbox’s .failed/ folder; retry re-imports the whole
// quarantine.
import { useFailures } from "../useFailures";
import { FamilyShell, FailRow, Section } from "../sections";

export default function ImportFailuresPage() {
  const { data, error, busy, msg, load, doRetry } = useFailures();

  return (
    <FamilyShell onRefresh={load} error={error} msg={msg}>
      <Section
        title="Import"
        hint="Files that failed verification/filing. Failed files are quarantined in the inbox’s .failed/ folder; retry re-imports them (whole quarantine)."
        count={data?.import.count ?? 0}
        onRetry={() => doRetry("import", {}, "import:all")}
        busy={busy === "import:all"}
        disabled={busy !== null}
        retryLabel="Retry quarantine"
      >
        {(data?.import.items ?? []).map((it, i) => (
          <FailRow
            key={`i${it.batch_id}-${i}`}
            title={it.file}
            error={it.error}
            when={it.created_at}
            badge={it.origin ?? undefined}
          />
        ))}
      </Section>
    </FamilyShell>
  );
}
