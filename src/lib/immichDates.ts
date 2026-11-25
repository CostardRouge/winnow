// Pushing corrected capture dates to Immich (docs/CAPTURE-TIME.md §5, C2).
//
// Immich keeps the browsing/phone job and receives BYTE copies of the
// originals (lib/export.ts), so it reads each file's own date — the wrong one,
// for a camera whose clock a human corrected in Winnow (migration 0061). This
// module tells it, through its own "Change date" (lib/immich.ts):
//   - after a correction or its Undo, for every moved media already pushed
//     (`exports.kind = 'immich'`, `output_key` = the Immich asset id);
//   - at push time, for a media that carries a correction (lib/export.ts).
// It runs after the database commit and never fails the gesture: a refusal is
// counted and its first message kept on the correction's report.
import { many } from "./db";
import { immichConfigured, immichSetDateTimeOriginal } from "./immich";
import { type ImmichDateReport, immichDateIso } from "./captureCorrectionTypes";

/** Small and sequential-ish: Immich is a neighbour on the same box. */
const CONCURRENCY = 4;

/** The date Immich should show for each of these assets' pushed copies. */
async function targets(assetIds: number[]) {
  return many<{
    output_key: string;
    captured_ms: number;
    captured_at_source: string | null;
    capture_offset_min: number | null;
  }>(
    `SELECT DISTINCT e.output_key,
            (extract(epoch FROM a.captured_at) * 1000)::float8 AS captured_ms,
            a.captured_at_source, a.capture_offset_min
       FROM exports e
       JOIN assets a ON a.id = e.source_asset_id
      WHERE e.kind = 'immich' AND e.output_key IS NOT NULL
        AND a.captured_at IS NOT NULL
        AND e.source_asset_id = ANY($1::bigint[])`,
    [assetIds],
  );
}

/**
 * Set the date of every pushed copy of these assets to their (corrected)
 * capture time. Null when Immich is not configured or nothing was pushed.
 */
export async function pushCapturedDates(
  assetIds: number[],
  // Injected by the tests; the real one only runs when Immich is configured.
  setDateOverride?: (assetId: string, iso: string) => Promise<void>,
): Promise<ImmichDateReport | null> {
  if (!assetIds.length) return null;
  if (!setDateOverride && !immichConfigured()) return null;
  const setDate = setDateOverride ?? immichSetDateTimeOriginal;
  const rows = await targets(assetIds);
  if (!rows.length) return null;
  const report: ImmichDateReport = { updated: 0, failed: 0, error: null };
  let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const r = rows[next++];
      try {
        await setDate(
          r.output_key,
          immichDateIso(Number(r.captured_ms), r.captured_at_source, r.capture_offset_min),
        );
        report.updated++;
      } catch (err) {
        report.failed++;
        report.error ??= (err as Error).message;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));
  return report;
}
