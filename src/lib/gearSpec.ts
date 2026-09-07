// From an EXIF string to what the gear IS: the classification and the optics
// behind the /gear page.
//
// This file used to be `gearArt.ts` and drove hand-generated line-art portraits
// (body archetype → footprint in millimetres → SVG). The drawings are gone —
// the page now reads its own numbers instead of illustrating them — but the two
// derivations that were feeding them are worth more than the pictures were:
//
//   - a body's ARCHETYPE, because the library can hold any camera anyone ever
//     pointed at anything and "Reflex / Mirrorless / Phone / Drone" is the one
//     honest thing we can say about an unknown EXIF string;
//   - a lens' OPTICS, read off the name where it states them and off the frames
//     it actually recorded otherwise — the focal range and the fastest aperture
//     are what the coverage view plots and what every spec line says.
//
// Pure functions, no React and no DB.

// ---------------------------------------------------------------- cameras ----

export type CameraKind =
  | "dslr" // reflex, mirror and prism
  | "slr" // mirrorless with a centred EVF hump (X-T5, A7, EOS R, Z6)
  | "rangefinder" // flat top plate, finder in the corner (X-E5, X100V, A6700)
  | "compact" // pocketable, fixed lens (GR IIIx, RX100)
  | "phone"
  | "drone"
  | "action" // GoPro-shaped cube
  | "camcorder";

/** How a kind names itself on the shelf. Deliberately plain, never a model. */
export const CAMERA_KINDS: Record<CameraKind, string> = {
  dslr: "Reflex",
  slr: "Mirrorless",
  rangefinder: "Rangefinder style",
  compact: "Compact",
  phone: "Phone",
  drone: "Drone",
  action: "Action cam",
  camcorder: "Camcorder",
};

// trim + collapse whitespace + lowercase, so the matchers below tolerate the
// casing and spacing quirks different makers write ("NIKON D850", "X-T5", …).
function norm(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

// Ordered matchers — FIRST hit wins, so the specific families come before the
// broad ones. Notably: "iPhone 12 mini" must be a phone before /mini \d/ reads
// it as a DJI Mini, and the flat-top mirrorless bodies (A7C, A6700) must be
// claimed before the /ilce-7|a7/ hump rule.
const MATCHERS: [CameraKind, RegExp][] = [
  // Phones report a marketing name (iPhone, Pixel) or an internal SKU (SM-…,
  // OnePlus A5010 — cf. lib/cameraLabels.ts).
  [
    "phone",
    /iphone|ipad|ipod|pixel|galaxy|\bsm-[a-z]\d|oneplus|xiaomi|redmi|\bpoco\b|huawei|honor|\boppo\b|\bvivo\b|nothing phone|motorola|\bmoto [ge]\b|nexus/,
  ],
  // Drones write the flight-controller board code (FC-nnnn) as often as a name.
  [
    "drone",
    /\bdji\b|mavic|phantom \d|inspire \d|avata|\bfc\d{3,4}\b|autel|\bevo (ii|lite|nano)|skydio|parrot|anafi/,
  ],
  ["action", /gopro|hero\s?\d|osmo (action|pocket)|insta360|\bone (rs|x\d)\b|virb/],
  ["camcorder", /handycam|camcorder|\bhdr-[a-z]|\bfdr-ax|\bhc-x\d|\bag-[a-z]|\bxa\d{2}|\bur\d{2}\b/],
  // Reflex bodies: Canon "EOS 5D Mark III"/"EOS 90D", Nikon "D850", Pentax
  // "K-3", Sony's A-mount SLT translucent-mirror line.
  ["dslr", /eos-?1d|eos \d{1,4}d\b|eos rebel|\bnikon d\d|\bd[1-8]\d{2,3}\b|\bslt-|\bk-[1357x]\b|\bist\b|\bsd1\b/],
  // Fixed-lens pocketables.
  [
    "compact",
    /ricoh gr|\bgr ii{1,2}x?\b|\bgriii|\brx0\b|\brx100|powershot|coolpix|\bxf10\b|\bx70\b|\btg-\d|\bdsc-(w|hx|t)|\blx\d|\bzs\d|\bg[579] x\b|\bstylus\b/,
  ],
  // Flat-top / corner-finder mirrorless — checked before the hump rule since
  // several share a family prefix with it (ILCE-7C vs ILCE-7, X-E vs X-T).
  [
    "rangefinder",
    /\bx-e\d|\bx-pro\d|\bx100|\bx-a\d|\bx-m\d|ilce-6\d00|ilce-7c|\ba6\d00\b|\ba7c\b|\bnex-|leica [mq]\b|\btyp \d{3}|sigma fp|\be-p\d|\bpen-f\b|\bz fc\b|\bzf\b|\bdc-gx|\bdmc-gx|\bzv-e/,
  ],
  // Mirrorless with a centred EVF hump.
  [
    "slr",
    /\bx-[ht]\d|\bx-s\d{2}|\bx-s\d\b|ilce-\d|\ba7\b|\ba7r|\ba7s|\ba9\b|\ba1\b|eos r\d?\b|\bz [5-9]\b|\bz\d{1}\b|nikon z|\be-m\d|\bom-\d|\bdc-g|\bdc-s\d|\bdmc-g|lumix s|\bgfx|\bs1r?\b|\bk-\d{2}/,
  ],
];

/**
 * Classify an EXIF camera string into an archetype. Unknown cameras fall back
 * to "rangefinder style": the most neutral shape of the set, and never wrong in
 * an embarrassing way — an unrecognised body is far likelier to be a flat-top
 * mirrorless than a drone.
 */
export function cameraKind(name: string): CameraKind {
  const s = norm(name);
  return MATCHERS.find(([, re]) => re.test(s))?.[0] ?? "rangefinder";
}

// ----------------------------------------------------------------- lenses ----

export type LensOptics = {
  zoom: boolean;
  focalMin: number | null;
  focalMax: number | null;
  /** Fastest aperture: read off the name, else the fastest one ever recorded. */
  aperture: number | null;
};

/** EXIF focal/aperture stats for a lens, straight from the aggregate. */
export type LensExif = {
  focalMin?: number | null;
  focalMax?: number | null;
  aperture?: number | null;
};

/**
 * Read a lens' optics off its name plus the focal/aperture range its files
 * actually recorded. The name wins where it states something (it is the
 * manufacturer's own spec) and the EXIF fills the rest, which is what lets
 * adapted and third-party glass — whose name says nothing — still show a range.
 */
export function lensOptics(name: string, exif: LensExif = {}): LensOptics {
  const s = name.replace(/\s+/g, " ").trim();

  // "18-55mm" / "70-300 mm" → a zoom, stated on the barrel.
  const range = s.match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*mm/i);
  // "56mm", "XF27mmF2.8" → a prime.
  const single = s.match(/(\d+(?:\.\d+)?)\s*mm/i);
  // "f/1.2", "F2.8", "f1.4" — the first number wins on variable-aperture zooms
  // ("f/3.5-5.6"), which is what the front of the barrel advertises. The focal
  // token is cut out first: in "XF35mmF1.4" or "XF 18-55mm", the F of the
  // mount name fronts the focal length, and without the cut it would read as
  // f/35 or f/18.
  const rest = range ? s.replace(range[0], " ") : single ? s.replace(single[0], " ") : s;
  const fstop = rest.match(/f\/?\s*(\d+(?:\.\d+)?)/i);
  // Manual and third-party glass often states the aperture without the "f"
  // ("35mm 0.95", "18-35 1.8"). Only looked for AFTER the focal length, so a
  // focal digit or a "Mark II" can't pass for an f-number.
  const tail = single ? s.slice(s.indexOf(single[0]) + single[0].length) : "";
  const bare = tail.match(/(?:^|\s)(0?\.\d{2}|\d(?:\.\d)?)(?=$|\s)/);

  let focalMin = range ? Number(range[1]) : single ? Number(single[1]) : null;
  let focalMax = range ? Number(range[2]) : focalMin;
  // No focal on the name (adapted or third-party glass that reports a bare
  // model): fall back to what the frames recorded.
  if (focalMin == null && exif.focalMin != null) focalMin = exif.focalMin;
  if (focalMax == null && exif.focalMax != null) focalMax = exif.focalMax;

  let aperture = fstop ? Number(fstop[1]) : bare ? Number(bare[1]) : null;
  if (aperture == null || aperture < 0.5 || aperture > 45) aperture = exif.aperture ?? null;

  // A zoom either says so on the barrel, or gives itself away by having shot a
  // spread of focal lengths.
  const zoom = !!range || (focalMin != null && focalMax != null && focalMax - focalMin > 2);

  return { zoom, focalMin, focalMax, aperture };
}

/** "56mm f/1.2" — the spec line under a lens name, from the derived numbers. */
export function lensSpecLabel(o: LensOptics): string {
  const focal =
    o.focalMin == null
      ? null
      : o.zoom && o.focalMax != null && o.focalMax !== o.focalMin
        ? `${Math.round(o.focalMin)}-${Math.round(o.focalMax)}mm`
        : `${Math.round(o.focalMin)}mm`;
  const ap = o.aperture == null ? null : `f/${o.aperture}`;
  return [focal, ap].filter(Boolean).join(" · ");
}
