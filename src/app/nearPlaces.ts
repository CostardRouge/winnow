// The positions a human already applied around a window — a hand-placed pin
// or an accepted suggestion, GET /api/assets/unplaced/places — as the one-click
// chips a Place dialog (GeotagRecapModal's `places`) offers under its map:
// "same place as the folder I did yesterday". Shared by the two hosts that
// place media in bulk, the Unplaced view (a card) and the Timeline (a chapter),
// so a chip reads the same wherever it is offered.
//
// A convenience, never a gate: a failed read resolves to no chips and the
// dialog opens anyway. Offered only — nothing here seeds a pin (cf.
// lib/unplaced.ts, placesNear, on why an accepted suggestion must never become
// a donor).
import { fetchJson } from "@/lib/fetchJson";
import { gapText } from "@/lib/unplacedFormat";
import type { UnplacedPlace } from "@/lib/unplacedTypes";
import type { RecapPlace } from "@/app/GeotagRecapModal";

const fmt = (n: number) => n.toLocaleString("en-GB");

/** One spot as a chip. `subject` is what the gap is measured from, in the
 *  hover sentence: "3 days after this card", "5 h before this chapter". */
export function placeChip(p: UnplacedPlace, subject = "this card"): RecapPlace {
  const label = p.name ?? `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`;
  return {
    lat: p.lat,
    lon: p.lon,
    label,
    detail: `${gapText(p.gap_h)} · ${fmt(p.count)}`,
    title: `${fmt(p.count)} media placed here, ${gapText(p.gap_h)} ${subject}${p.verified ? " — some placed by hand" : " — accepted suggestions"}`,
    verified: p.verified,
  };
}

/** The chips for a window given as two instants (any form Date parses). */
export function fetchNearPlaces(t0: string, t1: string, subject?: string): Promise<RecapPlace[]> {
  return fetchJson<{ places: UnplacedPlace[] }>(
    `/api/assets/unplaced/places?${new URLSearchParams({
      from: new Date(t0).toISOString(),
      to: new Date(t1).toISOString(),
    })}`,
  )
    .then((r) => r.places.map((p) => placeChip(p, subject)))
    .catch(() => [] as RecapPlace[]);
}
