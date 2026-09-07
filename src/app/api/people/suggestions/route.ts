// GET /api/people/suggestions → pairs of stacks that probably ARE the same
// person (centroid cosine just under the assignment threshold, cf.
// lib/people.suggestMerges), most-alike first. Ids only — the /people page
// already holds every person's card data and resolves them locally. Nothing
// is merged here: the suggestions UI proposes, the user clicks each merge.
import { suggestMerges } from "@/lib/people";
import { json, serverError } from "@/lib/api";
import { featureOff } from "@/lib/featureGate";

export const dynamic = "force-dynamic";

export async function GET() {
  // Merge suggestions are the People section's own.
  const off = await featureOff("people");
  if (off) return off;

  try {
    return json({ suggestions: await suggestMerges() });
  } catch (err) {
    return serverError(err);
  }
}
