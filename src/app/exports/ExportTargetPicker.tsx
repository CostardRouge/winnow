"use client";

import { useEffect, useState } from "react";
import { fetchJson } from "@/lib/fetchJson";

// Destination picker for the export modals — "where do these keepers go?".
//
// It renders NOTHING when the deployment offers a single destination, which is
// the stock case (an export folder and nothing else): the flow stays exactly as
// it was, no extra choice to make. Setting IMMICH_ENABLED is what surfaces the
// second option, so the UI follows the server's capabilities instead of
// carrying its own setting (cf. GET /api/export/targets).
//
// Reuses the Volumes "Add folder" radio-card pattern (.type-choice*): same
// shape of decision, same look.

export type ExportTargetId = "capture_one" | "immich";

type Target = {
  id: ExportTargetId;
  label: string;
  hint: string;
  available: boolean;
  error?: string;
};

export default function ExportTargetPicker({
  value,
  disabled,
  onChange,
}: {
  value: ExportTargetId;
  disabled?: boolean;
  onChange: (target: ExportTargetId) => void;
}) {
  const [targets, setTargets] = useState<Target[] | null>(null);

  // `probe=1`: the Immich server is pinged and the API key validated while the
  // modal is open, so an unreachable server is reported here rather than as a
  // failed job ten minutes later.
  useEffect(() => {
    let alive = true;
    fetchJson<{ targets?: Target[] }>("/api/export/targets?probe=1")
      .then((d) => {
        if (alive) setTargets(d.targets ?? []);
      })
      .catch(() => {
        // The picker is an enhancement: if the probe fails, fall back to the
        // single local destination rather than blocking the export.
        if (alive) setTargets([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  // One destination (or still loading): nothing to choose.
  if (!targets || targets.length < 2) return null;

  const selected = targets.find((t) => t.id === value);

  return (
    <>
      <label className="modal-label">Destination</label>
      <div className="type-choices">
        {targets.map((t) => (
          <label
            key={t.id}
            className={`type-choice${value === t.id ? " active" : ""}${
              t.available ? "" : " is-disabled"
            }`}
          >
            <input
              type="radio"
              name="export-target"
              value={t.id}
              checked={value === t.id}
              disabled={disabled || !t.available}
              onChange={() => onChange(t.id)}
            />
            <span className="type-choice-label">{t.label}</span>
            <span className="type-choice-hint">
              {t.available ? t.hint : (t.error ?? "unavailable")}
            </span>
          </label>
        ))}
      </div>
      {selected && !selected.available && (
        <p className="modal-warn">{selected.error ?? "Destination unavailable."}</p>
      )}
    </>
  );
}
