// Whose camera is it — the ownership of a body, set by hand on /gear
// (migration 0053).
//
// The gear dimension knew WHAT shot a frame; it never knew WHO. A friend's
// Fujifilm with intact EXIF is as real a body as the maintainer's A7C II, so
// "everything I did not shoot" was not a filter anyone could write. Ownership
// is the missing fact, and it belongs to the BODY: claimed once on the shelf,
// it reaches every medium that body shot, in every grid, without a write to a
// single asset row (a body is one `device` string — the same key /gear groups
// on and `?device=` filters on).
//
// Three answers and a default:
//   mine   — with an optional span (owned_from / owned_until, capture dates,
//            inclusive): the iPhone 5s was his from 2013 to 2016, so a frame
//            it shot in 2013 is his, and a frame shot after he sold it is not.
//   other  — someone else's: a person of /people when they are there, a name
//            typed by hand otherwise (People off, or a photographer with no
//            face in the library). The name is stored either way, so deleting
//            the person never un-sorts their cameras.
//   none   — not a camera (an app's images, a laptop webcam).
//   (no row) — not sorted. Nothing is assumed: an unsorted body is neither
//            "shot by me" nor "by others" in a filter, it is its own bucket.
import { many, one, q } from "./db";
import type {
  GearOwner,
  GearOwnerKind,
  GearPerson,
} from "./gearTypes";

type OwnerRow = {
  device: string;
  owner: GearOwnerKind;
  person_id: number | null;
  owner_name: string | null;
  owned_from: string | null;
  owned_until: string | null;
};

/** Every body's owner, by device. A person's CURRENT name wins over the one
 *  stored, so renaming someone on /people renames their cameras' owner too. */
export async function listOwners(): Promise<Map<string, GearOwner>> {
  const rows = await many<OwnerRow>(
    `SELECT g.device, g.owner,
            p.id                         AS person_id,
            COALESCE(p.name, g.owner_name) AS owner_name,
            to_char(g.owned_from, 'YYYY-MM-DD')  AS owned_from,
            to_char(g.owned_until, 'YYYY-MM-DD') AS owned_until
       FROM gear_owners g
       LEFT JOIN people p ON p.id = g.person_id`,
  );
  return new Map(
    rows.map(({ device, ...o }) => [device, o]),
  );
}

/** The people "Whose?" offers: the named, visible stacks of /people. Read from
 *  the table directly, not from /api/people — that one counts every face of
 *  every person, and a picker needs a name. */
export async function listNamedPeople(): Promise<GearPerson[]> {
  return many<GearPerson>(
    `SELECT id, name FROM people
      WHERE name IS NOT NULL AND btrim(name) <> '' AND NOT hidden
      ORDER BY lower(name), id`,
  );
}

export type OwnerInput = {
  device: string;
  /** null = back to "not sorted" (the row is removed). */
  owner: GearOwnerKind | null;
  personId?: number | null;
  name?: string | null;
  from?: string | null;
  until?: string | null;
};

/** A body name that the library does not hold — refused rather than stored for
 *  a camera that does not exist (a typo in a hand-written request). */
export class UnknownBody extends Error {
  constructor(readonly device: string) {
    super(`No live medium was shot with “${device}”`);
  }
}

/** A span that ends before it starts, or a person that is not there. */
export class BadOwner extends Error {}

/**
 * Set (or clear) one body's owner. Fields that do not apply to the answer are
 * dropped rather than refused — a "Mine" sent with a leftover person from the
 * dialog's other tab stores no person — and the CHECKs in 0053 back that up.
 */
export async function setOwner(input: OwnerInput): Promise<GearOwner | null> {
  const known = await one<{ ok: boolean }>(
    `SELECT true AS ok FROM assets
      WHERE device = $1 AND deleted_at IS NULL LIMIT 1`,
    [input.device],
  );
  if (!known) throw new UnknownBody(input.device);

  if (input.owner == null) {
    await q("DELETE FROM gear_owners WHERE device = $1", [input.device]);
    return null;
  }

  const mine = input.owner === "mine";
  const other = input.owner === "other";
  const from = mine ? input.from || null : null;
  const until = mine ? input.until || null : null;
  if (from && until && from > until)
    throw new BadOwner("“Mine from” comes after “until”");

  let personId = other ? (input.personId ?? null) : null;
  let name = other ? input.name?.trim().replace(/\s+/g, " ") || null : null;
  if (personId != null) {
    const person = await one<{ name: string | null }>(
      "SELECT name FROM people WHERE id = $1",
      [personId],
    );
    if (!person) throw new BadOwner("That person no longer exists");
    // Kept beside the id: the fallback once the person is deleted.
    name = person.name ?? name;
  }

  await q(
    `INSERT INTO gear_owners (device, owner, person_id, owner_name, owned_from, owned_until)
     VALUES ($1, $2, $3, $4, $5::date, $6::date)
     ON CONFLICT (device) DO UPDATE
        SET owner = EXCLUDED.owner, person_id = EXCLUDED.person_id,
            owner_name = EXCLUDED.owner_name,
            owned_from = EXCLUDED.owned_from, owned_until = EXCLUDED.owned_until,
            updated_at = now()`,
    [input.device, input.owner, personId, name, from, until],
  );
  return (await listOwners()).get(input.device) ?? null;
}
