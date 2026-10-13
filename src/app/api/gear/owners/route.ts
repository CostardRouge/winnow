// POST /api/gear/owners -> whose camera a body is (cf. lib/gearOwners.ts,
// migration 0053). One body per call: the "Whose?" dialog on /gear and the
// sort deck both answer one camera at a time.
//
//   { device, owner: "mine" | "other" | "none" | null,
//     person_id?, name?, from?, until? }
//
// `owner: null` puts the body back to "not sorted". Fields that do not apply
// to the answer are ignored (a person on "mine", dates on "other"). Editor and
// up, like every curation write (lib/authz.ts default).
import { NextRequest } from "next/server";
import { z } from "zod";
import { BadOwner, setOwner, UnknownBody } from "@/lib/gearOwners";
import { badRequest, json, serverError } from "@/lib/api";
import { featureOff } from "@/lib/featureGate";

export const dynamic = "force-dynamic";

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "a date is YYYY-MM-DD")
  .nullish();

const Body = z.object({
  device: z.string().min(1).max(200),
  owner: z.enum(["mine", "other", "none"]).nullable(),
  person_id: z.number().int().positive().nullish(),
  name: z.string().max(120).nullish(),
  from: day,
  until: day,
});

export async function POST(req: NextRequest) {
  // The shelf owns this write: with Gear off there is nowhere to make it from.
  const off = await featureOff("gear");
  if (off) return off;
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success)
      return badRequest(parsed.error.issues[0]?.message ?? "invalid body", parsed.error.issues);
    const b = parsed.data;
    try {
      const owner = await setOwner({
        device: b.device,
        owner: b.owner,
        personId: b.person_id ?? null,
        name: b.name ?? null,
        from: b.from ?? null,
        until: b.until ?? null,
      });
      return json({ device: b.device, owner });
    } catch (err) {
      if (err instanceof UnknownBody || err instanceof BadOwner)
        return badRequest(err.message);
      throw err;
    }
  } catch (err) {
    return serverError(err);
  }
}
