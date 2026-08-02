"use client";

// Failures › Missing files: indexed media whose original is gone from disk —
// re-check, restore, or purge, plus the full integrity sweep.
import { useFailures } from "../useFailures";
import { FamilyShell } from "../sections";
import MissingSection from "../MissingSection";

export default function MissingFailuresPage() {
  const { data, error, msg, setMsg, load } = useFailures();

  return (
    <FamilyShell onRefresh={load} error={error} msg={msg}>
      <MissingSection
        count={data?.missing.count ?? 0}
        items={data?.missing.items ?? []}
        onChanged={load}
        setMsg={setMsg}
      />
    </FamilyShell>
  );
}
