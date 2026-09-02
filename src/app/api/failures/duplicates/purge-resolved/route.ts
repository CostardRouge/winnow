// POST /api/failures/duplicates/purge-resolved -> clears the duplicate_hits
// rows that no longer describe a real duplication: a file removed by hand
// outside this page, a hash still held by an already-purged library entry (the
// "no file left on disk" entries that could never resolve on their own), and the
// lone copies nothing shadows any more. See sweepResolvedDuplicateHits in
// lib/duplicates for the three cases and their safety rules — no file is ever
// touched here.
import { json, serverError } from "@/lib/api";
import { sweepResolvedDuplicateHits } from "@/lib/duplicates";

export const dynamic = "force-dynamic"; // DB-backed route: never pre-rendered/cached at build time

export async function POST() {
  try {
    return json(await sweepResolvedDuplicateHits());
  } catch (err) {
    return serverError(err);
  }
}
