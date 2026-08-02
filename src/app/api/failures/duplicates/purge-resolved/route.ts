// POST /api/failures/duplicates/purge-resolved -> drops duplicate_hits rows
// whose recorded file no longer exists on disk. Covers the case where a
// duplicate copy was removed by hand (outside "Delete"/"Keep only
// this"/"Discard" here) and its audit row was left behind claiming a file
// that's already gone. See purgeResolvedDuplicateHits in lib/duplicates for
// the safety rule (ENOENT only, never on an ambiguous stat error).
import { json, serverError } from "@/lib/api";
import { purgeResolvedDuplicateHits } from "@/lib/duplicates";

export async function POST() {
  try {
    const result = await purgeResolvedDuplicateHits();
    return json(result);
  } catch (err) {
    return serverError(err);
  }
}
