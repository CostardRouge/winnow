"use client";

// Failures › Deduplication: the duplicate-triage surface, on its own URL so a
// review session ("here, sort these out") can be linked to directly.
import { useFailures } from "../useFailures";
import { FamilyShell } from "../sections";
import DedupSection from "../DedupSection";

export default function DuplicatesFailuresPage() {
  const { data, error, msg, setMsg, load } = useFailures();

  return (
    <FamilyShell onRefresh={load} error={error} msg={msg}>
      <DedupSection
        count={data?.duplicates.count ?? 0}
        falseCollisions={data?.duplicates.falseCollisions ?? 0}
        items={data?.duplicates.items ?? []}
        onChanged={load}
        setMsg={setMsg}
      />
    </FamilyShell>
  );
}
