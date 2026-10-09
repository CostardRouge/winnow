"use client";

// Settings › Pipeline › Dates & places, as the two steps it is, in order:
// 1. read the capture times the database cannot classify (lib/captureDays.ts),
// 2. optionally place what has no position from a GPS track (lib/trackImport.ts),
// 3. put back the hand-placed positions the GPS write-back mirrored
//    (lib/mirrorRepair.ts) — a one-off repair, "Done" once nothing is left.
// The order matters — a track import skips a time it cannot tell from a wall
// clock — so the counts both steps depend on are loaded once, here, and each
// step says where it stands rather than leaving the reader to infer it.
import { useCallback, useEffect, useState } from "react";
import { fetchJson } from "@/lib/fetchJson";
import type { CaptureDayStats } from "@/lib/captureDays";
import CaptureDaysSection from "./CaptureDaysSection";
import TrackImportSection from "./TrackImportSection";
import MirrorRepairSection from "./MirrorRepairSection";

export default function CaptureFlow() {
  const [stats, setStats] = useState<CaptureDayStats | null>(null);
  const [windowH, setWindowH] = useState(12);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const r = await fetchJson<{ stats: CaptureDayStats; neighbourWindowHours: number }>(
        "/api/pipeline/capture-days",
      );
      setStats(r.stats);
      setWindowH(r.neighbourWindowHours);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div className="flow">
      <p className="hint flow-intro">
        When and where each frame was taken, beyond what its file says. Two steps, in this
        order, and a repair; originals are only ever read, except to write back a corrected
        hand-placed position.
      </p>
      {error && <p className="hint">{error}</p>}
      <CaptureDaysSection stats={stats} windowH={windowH} onChanged={reload} />
      <TrackImportSection toRead={stats?.toRead ?? 0} onChanged={reload} />
      <MirrorRepairSection onChanged={reload} />
    </div>
  );
}
