"use client";

// Failures › Missing files: indexed media whose original is gone from disk —
// re-check, restore, or purge, plus the full integrity sweep.
//
// The relink section sits below it and is ALWAYS rendered, even with an empty
// missing list: a purge stamps `purged_at`, which drops those rows out of
// listMissing() entirely, so the files a move stranded can be invisible here
// while still being perfectly recoverable (cf. lib/relink.ts).
import { useFailures } from "../useFailures";
import { FamilyShell } from "../sections";
import MissingSection from "../MissingSection";
import RelinkSection from "../RelinkSection";

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
      <RelinkSection onChanged={load} setMsg={setMsg} />
    </FamilyShell>
  );
}
